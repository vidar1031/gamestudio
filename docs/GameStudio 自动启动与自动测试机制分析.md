# GameStudio 自动启动与自动测试机制分析

> 文档版本: 2026-06-06  
> 分析范围: 控制平面 (`control-server` + `control-console`) + AI 运行时 (`Hermes`) + 业务平面 (`server` + `editor`) + 自动化测试体系  
> 架构原则: **Control-First** — 所有启动、自检、生产任务均由 Control 控制器编排

---

## 1. 概述

GameStudio 采用 **Control-First** 架构：控制平面 (`apps/control-server` + `apps/control-console`) 是整个系统的唯一编排入口，负责：

1. **启动并管理 Hermes** AI 运行时
2. **按需启动 GameStudio** 业务平面 (Server + Editor)
3. **执行 GameStudio 自检** 并把结果反馈给操作者
4. **驱动生产任务** (story workflow：创建项目 → 生成脚本 → 编译蓝图 → 校验 → 导出)

本文档详细描述从"零状态"到"生产任务执行"的完整工作结构，以及自动测试如何验证这个结构。

---

## 2. 全系统核心工作结构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户 / 操作者                                   │
│                         ↓ 通过 Control Console Chat                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                            Control 控制器                                    │
│  ┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────┐ │
│  │ apps/control-server │←──→│ apps/control-console │    │ reasoning/chat  │ │
│  │      (port 2099)    │    │      (port 8870)     │    │   工作流引擎     │ │
│  └─────────────────────┘    └─────────────────────┘    └─────────────────┘ │
│         │ spawn Python 子进程        │                                        │
│         ↓                             │ 调用 bootstrap/workflow 计划          │
│  ┌─────────────────────┐              ↓                                        │
│  │   Hermes Gateway    │←──────────────────────────────┐                      │
│  │     (port 8742)     │                               │                      │
│  └─────────────────────┘                               │                      │
│         │ 模型推理请求                                    │                      │
│         ↓                                              │                      │
│  ┌─────────────────────┐                               │                      │
│  │   OMLX 模型服务      │                               │                      │
│  │    (port 18888)     │                               │                      │
│  └─────────────────────┘                               │                      │
│                                                        ↓                      │
│                                               ┌─────────────────────┐         │
│                                               │  GameStudio 业务平面 │         │
│                                               │  server  :1999      │         │
│                                               │  editor  :8868      │         │
│                                               └─────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**核心约束**：
- Control Server 是唯一的**进程管理者**：它 spawn Hermes，并通过白名单脚本启动 GameStudio
- Hermes 是唯一的**AI 推理入口**：所有模型调用（包括 planner、answer、chat）都经过 Hermes
- GameStudio 是**被动的业务平面**：只响应 HTTP API，不自主动作
- 用户不直接操作 GameStudio 命令行，所有动作通过 Control Console Chat 触发

---

### 2.2 阶段一：启动 Control 控制器

这是所有后续环节的前提。Control 必须先于 Hermes 和 GameStudio 启动。

#### 2.2.1 启动命令

```bash
./restart_control.sh
```

#### 2.2.2 启动时序

```
1. 检查 node_modules 存在性
2. 关闭旧 control-server (port 2099) → SIGTERM → SIGKILL → 等待端口释放
3. 关闭旧 control-console (port 8870) → 同上
4. spawn control-server: node apps/control-server/src/index.js
5. 轮询 GET :2099/api/health (最多 30s)
6. 写入 .run/control-server.pid
7. spawn control-console: vite --host 0.0.0.0 --port 8870
8. 轮询 GET :8870 (最多 30s)
9. 写入 .run/control-console.pid
10. 打印访问地址
```

#### 2.2.3 Control Server 启动期行为

- 加载 `config/hermes/` 下的 intents、skills、routing 配置
- 注册 12 个 intent（builtin + JSON）
- 执行 `cleanupOrphanedReasoningSessions()` 清理遗留 session
- 启动 Hono HTTP 服务，监听 :2099
- 此时 Hermes **未启动**， GameStudio **未启动**

#### 2.2.4 验证 Control 启动成功

```bash
curl -sS http://127.0.0.1:2099/api/health
# 期望: {"ok":true}

curl -sS http://127.0.0.1:8870
# 期望: HTTP 200 (Vite dev server ready)
```

---

### 2.3 阶段二：通过 Control 启动 Hermes + OMLX

Control 启动后，下一步是启动 AI 运行时。这个环节**必须**通过 Control Console UI 或 API 完成，不能手动运行 Hermes 脚本。

#### 2.3.1 配置左脑

在 Control Console 的"左脑配置"面板：
- 选择 Provider: `omlx`
- 选择 Base URL: `http://127.0.0.1:18888/v1`
- 选择 Model: 例如 `gpt-oss-20b-MXFP4-Q8`
- 点击"保存配置"

#### 2.3.2 预检 (Preflight)

保存后，Control Server 执行 `buildHermesPreflight()`：

```
1. 检测 Hermes 安装: /Volumes/ovokit2t/AIOVO/hermes-agent/scripts/hermes-gateway
2. 检测 Python venv: venv/bin/python
3. 获取 OMLX 模型目录: GET :18888/v1/models
4. 检测模型是否在目录中
5. 返回 ready / checks 数组
```

#### 2.3.3 启动 Hermes

预检通过后，点击"启动引擎"或调用 API：

```bash
curl -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/runtime-action \
  -H "Content-Type: application/json" \
  -d '{
    "action": "start",
    "brainSide": "left",
    "config": {
      "provider": "omlx",
      "baseUrl": "http://127.0.0.1:18888/v1",
      "model": "gpt-oss-20b-MXFP4-Q8"
    }
  }'
```

Control Server 内部执行 `startHermesRuntime()`：

```javascript
spawn('/Volumes/ovokit2t/AIOVO/hermes-agent/venv/bin/python',
      ['/Volumes/ovokit2t/AIOVO/hermes-agent/scripts/hermes-gateway', 'run'],
      {
        cwd: HERMES_ROOT,
        detached: true,
        env: {
          HERMES_HOME, HERMES_MODEL, HERMES_PROVIDER, HERMES_BASE_URL,
          API_SERVER_ENABLED: 'true',
          API_SERVER_HOST: '127.0.0.1',
          API_SERVER_PORT: '8742',
          GAMESTUDIO_AGENT_CONFIG_FILES: ...,  // 内存文件路径
          GAMESTUDIO_SKILL_ROOT: ...,
          OPENAI_BASE_URL: 'http://127.0.0.1:18888/v1',
          // ... 大量环境变量
        }
      })
```

#### 2.3.4 Hermes 启动后的自检

Hermes 启动后，Control Server 会：
- 写入 PID 文件: `/tmp/gamestudio-hermes-gateway.pid`
- 启动日志监控器，检测 OMLX 故障模式
- 启动周期性 PID 健康检查（30s 间隔）
- 轮询 `:8742/v1/models` 等待 API 就绪

---

### 2.4 阶段三：验证 Control 控制器运行正常

Control + Hermes 启动后，必须执行三项验证才能进入后续环节。

#### 2.4.1 验证清单

| # | 检查项 | API | 通过标准 |
|---|--------|-----|----------|
| 1 | Control Server 健康 | `GET /api/health` | `ok === true` |
| 2 | Hermes Runtime 状态 | `GET /api/control/agents/hermes-manager/runtime-status` | `state === 'running'` |
| 3 | Control 自检 | `GET /api/control/agents/hermes-manager/self-check` | `ok === true` |
| 4 | Hermes API 就绪 | `GET :8742/v1/models` | JSON 含 `data` 数组 |
| 5 | OMLX 模型服务 | `GET :18888/v1/models` | JSON 含 `data` 数组 |

#### 2.4.2 Control 自检内容

`buildHermesSelfCheck()` 检查：
- **Python Environment**: venv/bin/python 是否存在
- **Workspace Access**: GameStudio 工作区是否可读写
- **Model Route**: Hermes runtime 是否 running
- **Config Validation**: 左脑配置是否完整

---

### 2.5 阶段四：通过 Control 启动 GameStudio

Control 和 Hermes 就绪后，用户通过 Control Console Chat 发送 bootstrap 类提示词来启动 GameStudio。

#### 2.5.1 触发条件

用户的提示词匹配 `GAMESTUDIO_BOOTSTRAP_PATTERN`：
```
/gamestudio|game studio|游戏工作室/ + /启动|打开|界面|工作台|editor|workbench|自检|检查|配置|comfyui|本地模型|diagnose|preflight|bootstrap|settings/
```

例如：
- "启动 GameStudio"
- "打开游戏工作室界面"
- "配置 ComfyUI 本地模型"
- "执行 GameStudio 自检"

#### 2.5.2 请求分类

`classifyReasoningRequest()` 将请求分类为 `gamestudio_bootstrap_execute`，route 为 `workflow_execute`。

#### 2.5.3 Bootstrap 计划生成

`buildGameStudioBootstrapPlan()` 生成顺序执行计划：

```
step_gamestudio_ensure_running
  └─ 检查 :1999/api/health
  └─ 若失败，调用 ./start_project.sh --detached（180s timeout）
  └─ 等待 server/editor 就绪
  └─ 若 image provider 为 comfyui，检测/启动 ComfyUI

step_gamestudio_open_editor
  └─ 检查 editor 可访问
  └─ 在 macOS 上调用 open 命令打开浏览器（复用已有标签）
  └─ 可选打开 ai-create-story 入口

step_gamestudio_read_settings  (若提示词含"自检/检查/配置")
  └─ GET /api/studio/settings

step_gamestudio_configure_local_production  (若提示词含"配置/本地模型/ComfyUI")
  └─ PUT /api/studio/settings
  └─ 写入 scripts.provider=localoxml, image.provider=comfyui

step_gamestudio_self_check  (若提示词含"自检/检查/配置")
  ├─ GET /api/health
  ├─ GET /api/studio/settings
  ├─ POST /api/studio/diagnose
  ├─ 确保 ComfyUI 运行
  └─ POST /api/studio/image/preflight

step_gamestudio_bootstrap_answer
  └─ 汇总所有步骤结果，生成 final answer
  └─ 包含 evaluator: evaluateGameStudioBootstrapSummary
```

#### 2.5.4 关键机制：Control 调用 GameStudio 启动脚本

在 `executeGameStudioBootstrapStep()` 中：

```javascript
if (action === 'gamestudio_ensure_running') {
  let serverHealth = await fetchOk(healthUrl)
  if (!serverHealth.ok) {
    startResult = await runLocalCommand(
      'bash',
      ['./start_project.sh', '--detached'],
      { cwd: GAMESTUDIO_ROOT, timeoutMs: 180000 }
    )
    serverHealth = await waitForHttpOk(healthUrl, { timeoutMs: 60000 })
  }
}
```

这是 Control-First 架构的核心体现：**GameStudio 不是由用户手动启动的，而是由 Control 在需要时自动拉起**。

---

### 2.6 阶段五：GameStudio 自检（由 Control 执行）

GameStudio 启动后，其自检不是由 GameStudio 主动上报，而是由 Control 通过 HTTP API **主动探测**。

#### 2.6.1 自检内容

`gamestudio_self_check` 步骤执行以下检查：

| # | 检查项 | GameStudio API | 说明 |
|---|--------|----------------|------|
| 1 | Server 健康 | `GET /api/health` | 基本可用性 |
| 2 | Studio Settings | `GET /api/studio/settings` | 读取当前生效配置 |
| 3 | AI 诊断 | `POST /api/studio/diagnose` | 诊断 AI 服务连接状态 |
| 4 | ComfyUI 就绪 | `GET :8188/system_stats` 或启动脚本 | 若 image provider 为 comfyui |
| 5 | 图片 Preflight | `POST /api/studio/image/preflight` | 验证图片生成服务可用性 |

#### 2.6.2 自检结果处理

每个子检查的结果通过 `observeGameStudioOperation()` 记录到 reasoning session 的 artifacts 中：

```javascript
session.artifacts.gameStudioBootstrap.steps.step_gamestudio_self_check = {
  ok: true/false,
  data: { health, settings, diagnose, comfyUi, preflight },
  evaluator: { name: 'evaluateGameStudioSelfCheck', passed, checks },
  failedStage: null | 'gamestudio_health' | 'gamestudio_settings' | ...,
  retryable: true/false
}
```

若任一子检查失败，bootstrap answer 会明确列出失败项，不会继续进入生产任务。

---

### 2.7 阶段六：GameStudio 生产任务

Bootstrap 成功后，用户可以通过 Control Console Chat 发送 story workflow 类提示词来执行生产任务。

#### 2.7.1 触发条件

提示词匹配 `STORY_WORKFLOW_PATTERN`：
```
/创建.*故事|新建.*故事|生成.*故事|故事项目|互动故事|项目配置|生成配置|脚本|分镜|资产|出图|导出项目|validate project|锁定测试|lock_test/i
```

例如：
- "创建一个互动故事，题目是雨夜咖啡馆的时间循环"
- "生成脚本并写回项目"
- "编译 blueprint 并导出 H5"

#### 2.7.2 请求分类

`classifyReasoningRequest()` 分类为 `story_workflow_execute`。

#### 2.7.3 Story Workflow 计划

`buildStoryWorkflowPlan()` 生成典型计划：

```
step_story_create_project
  └─ POST /api/projects

step_story_configure_project
  └─ PUT /api/projects/:id/generation-config

step_story_generate_scripts_candidate
  └─ POST /api/projects/:id/ai/scripts/candidate

step_story_write_scripts
  └─ PUT /api/projects/:id/scripts

step_story_compile_blueprint
  └─ POST /api/projects/:id/blueprint/compile

step_story_compile_compose
  └─ POST /api/projects/:id/compose/compile

step_story_validate_project
  └─ POST /api/projects/:id/validate

step_story_export_project
  └─ POST /api/projects/:id/exports/h5

step_story_preflight_image_provider
  └─ POST /api/studio/image/preflight

step_story_answer
  └─ 汇总所有步骤结果
```

#### 2.7.4 审核门禁

写操作（write scripts、export project 等）默认 `reviewPolicy: 'required'`，会在 Control Console 的"可观测推理链"面板暂停，等待人工 approve/reject。

---

## 3. 自动启动机制

### 3.1 服务矩阵

| 服务 | 端口 | 启动方式 | 健康检查 |
|------|------|----------|----------|
| Control Server | 2099 | `restart_control.sh` | `GET /api/health` |
| Control Console | 8870 | `restart_control.sh` | `GET /` |
| Hermes Gateway | 8742 | Control Server spawn Python | `GET /v1/models` |
| GameStudio Server | 1999 | Control 按需调用 `./start_project.sh --detached` | `GET /api/health` |
| GameStudio Editor | 8868 | 随 `start_project.sh` 启动 | `GET /` |
| OMLX 模型服务 | 18888 | 外部（用户手动启动） | `GET /v1/models` |

### 3.2 启动脚本索引

| 脚本 | 路径 | 用途 | 触发者 |
|------|------|------|--------|
| `restart_control.sh` | `./restart_control.sh` | 启动 Control Server + Console | 用户 / 测试脚本 |
| `start_project.sh` | `./start_project.sh` | 启动 GameStudio Server + Editor | Control 按需调用 |
| `stop_project.sh` | `./stop_project.sh` | 停止 GameStudio | 用户 |
| `status_project.sh` | `./status_project.sh` | 查看运行状态 | 用户 / reporter |
| `restart_server.sh` | `scripts/lifecycle/restart_server.sh` | 仅重启 GameStudio Server | 用户 |
| `start_server.sh` | `scripts/lifecycle/start_server.sh` | 仅启动 GameStudio Server | 用户 |

---

## 4. 自动测试机制

### 4.1 测试分层

```
Layer 0: 构建时检查
  - npm run build:packages
  - npm run typecheck

Layer 1: Smoke Test
  - smoke_test_pipeline.sh → control_production_test.mjs

Layer 2: Control Production Test (L1~L5)
  - bootstrap / L1 / L2 / L3 / L4 / L5 / manual-gate

Layer 3: Test Dashboard
  - scripts/test-dashboard/server.mjs
```

### 4.2 Control Production Test 阶段

| 阶段 | ID | 类型 | 说明 | 硬门禁 |
|------|-----|------|------|--------|
| 初级起步 | `bootstrap` | bootstrap | Control health / Hermes runtime / Self-check / OMLX 模型目录 | 是 |
| L1 硬门禁 | `l1` | reasoning | 模型链路、角色定位、Thinking 策略 | **是** |
| L2 事实源 | `l2` | reasoning | storage/projects 事实源、GameStudio Server API | 否 |
| L3 安全边界 | `l3` | reasoning | 路径越界、脚本白名单、写入审核 | 否 |
| L4 P0 闭环 | `l4` | reasoning | Story workflow 完整闭环 | 否 |
| L5 运维稳定性 | `l5` | reasoning | 取消/恢复、生命周期控件、日志追溯 | 否 |
| 生产结论 | `manual-gate` | manual | PASS / FAIL / BLOCKED | 否 |

### 4.3 Bootstrap 测试检查项

```
BOOT-01: 检查或启动 control
  └─ 未运行则执行 restart_control.sh

BOOT-02: 检查 control health
  └─ GET /api/health

BOOT-03: 检查 control console 可访问
  └─ GET :8870

BOOT-04: 检查 Hermes runtime 状态并按需恢复
  └─ GET /runtime-status → state !== running 则 POST /runtime-action {action:resume}

BOOT-05: 执行 control 自检
  └─ GET /self-check

BOOT-06: 检查 OMLX 模型目录
  └─ GET /local-models?provider=omlx
```

---

## 5. 完整跑一次的全部工作环节

### 5.1 总览

```
[预备]
  ├─ npm install
  ├─ 确认 Hermes 已安装: /Volumes/ovokit2t/AIOVO/hermes-agent
  ├─ 确认 OMLX 已启动: :18888/v1/models
  └─ 确认 .env.local 配置正确

[阶段 1] 启动 Control
  └─ ./restart_control.sh
      ├─ 启动 control-server :2099
      └─ 启动 control-console :8870

[阶段 2] 配置并启动 Hermes
  └─ Control Console → 左脑配置
      ├─ provider=omlx
      ├─ baseUrl=http://127.0.0.1:18888/v1
      ├─ model=xxx
      ├─ 保存配置
      ├─ 执行 preflight
      └─ 点击"启动引擎"
          └─ Control spawn Hermes Gateway :8742

[阶段 3] 验证 Control + Hermes
  └─ GET /api/health
  └─ GET /runtime-status → running
  └─ GET /self-check → ok
  └─ GET :8742/v1/models
  └─ GET :18888/v1/models

[阶段 4] 启动 GameStudio
  └─ Control Console Chat: "启动 GameStudio"
      └─ classify → gamestudio_bootstrap_execute
      └─ buildGameStudioBootstrapPlan
          ├─ ensure_running → ./start_project.sh --detached
          ├─ open_editor → 浏览器打开
          ├─ read_settings
          ├─ configure_local_production (可选)
          └─ self_check

[阶段 5] 执行生产任务
  └─ Control Console Chat: "创建一个互动故事，题目是..."
      └─ classify → story_workflow_execute
      └─ buildStoryWorkflowPlan
          ├─ create_project
          ├─ configure_project
          ├─ generate_scripts_candidate
          ├─ write_scripts
          ├─ compile_blueprint
          ├─ compile_compose
          ├─ validate_project
          └─ export_project

[收尾]
  ├─ 归档测试结果 JSON
  ├─ 检查 state/reasoning-sessions/
  ├─ 检查 state/agent-runtime-events.jsonl
  └─ 决策：保留 / 停止 / 继续开发
```

### 5.2 各环节耗时估算

| 环节 | 耗时 |
|------|------|
| Control 启动 | 5~15s |
| Hermes preflight | 3~10s |
| Hermes 启动 | 5~15s |
| GameStudio bootstrap (ensure_running) | 10~30s（含 start_project.sh） |
| GameStudio self_check | 10~30s（含 diagnose + preflight） |
| L1 硬门禁 (3 cases) | 3~8min |
| L4 story workflow (9 cases) | 15~40min |
| 完整测试 (L1~L5) | 40~100min |

---

## 6. 长任务跟踪与验证计划

### 6.1 跟踪任务定义

#### 任务 A: Control 启动跟踪 (`track-control`)

**触发**: `./restart_control.sh`  
**频率**: 每 5s  
**采样**:
```bash
lsof -tiTCP:2099,8870 -sTCP:LISTEN
curl -sS http://127.0.0.1:2099/api/health
cat .run/control-server.pid .run/control-console.pid
tail -20 .run/control-server.log
```

#### 任务 B: Hermes 启动跟踪 (`track-hermes`)

**触发**: `POST /runtime-action {action:start}`  
**频率**: 每 5s  
**采样**:
```bash
cat /tmp/gamestudio-hermes-gateway.pid
ps -p $(cat /tmp/gamestudio-hermes-gateway.pid)
curl -sS http://127.0.0.1:8742/v1/models
curl -sS http://127.0.0.1:2099/api/control/agents/hermes-manager/runtime-status
tail -20 /tmp/gamestudio-hermes-gateway.log
```

#### 任务 C: GameStudio Bootstrap 跟踪 (`track-gamestudio`)

**触发**: Chat 发送 bootstrap 提示词  
**频率**: 每 10s  
**采样**:
```bash
curl -sS http://127.0.0.1:1999/api/health
curl -sS http://localhost:8868
curl -sS http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/${SESSION_ID}
ls -la state/reasoning-sessions/ | tail -3
```

#### 任务 D: 测试跟踪 (`track-test`)

**触发**: `control_production_test.mjs`  
**频率**: 每 30s  
**采样**:
```bash
ps aux | grep control_production_test | grep -v grep
wc -l state/agent-runtime-events.jsonl
grep "GATEWAY-WATCHER.*FAULT" /tmp/gamestudio-hermes-gateway.log | tail -3
```

### 6.2 日志采集规范

| 日志文件 | 关键模式 | 告警阈值 |
|---------|---------|---------|
| `.run/control-server.log` | `[FATAL]`, `unhandledRejection`, `SyntaxError` | 出现即告警 |
| `.run/server.log` | `HTTP 5xx`, `uncaughtException` | 出现即告警 |
| `/tmp/gamestudio-hermes-gateway.log` | `GATEWAY-WATCHER][FAULT]`, `Max retries exhausted` | 出现即告警 |
| `state/agent-runtime-events.jsonl` | `type:"error"`, `type:"cancel"` | 连续 3 条 error |
| `state/reasoning-sessions/*.json` | `status !== "completed"` | > 20% |

### 6.3 状态快照检查点

| 检查点 | 保存路径 |
|--------|---------|
| Control 启动后 | `docs/verify/snapshots/control-ready.json` |
| Hermes 启动后 | `docs/verify/snapshots/hermes-ready.json` |
| GameStudio bootstrap 完成 | `docs/verify/snapshots/gamestudio-bootstrap.json` |
| Story workflow 完成 | `docs/verify/snapshots/story-workflow.json` |
| 测试结束 | `docs/verify/snapshots/test-results.json` |

---

## 7. 当前实际状态（2026-06-06）

### 7.1 服务状态

```
control-server:   listening on :2099 (PID in .run/control-server.pid)
control-console:  listening on :8870 (PID in .run/control-console.pid)
hermes gateway:   状态需进一步确认（Control 已启动但 Hermes 可能未 spawn）
gamestudio server: not listening on :1999
gamestudio editor: not listening on :8868
omlx model:       fail（:18888 无响应）
```

### 7.2 关键目录事实

```
scripts/lifecycle/        # 生命周期脚本目录（启动、停止、reporter）
config/email_config.sh    # reporter 邮件配置
state/reasoning-sessions/ # 288 个历史 session
```

### 7.3 阻塞项

- OMLX 未运行，导致 Hermes preflight 和模型调用都会失败
- GameStudio 业务平面未启动
- 要进行完整测试，必须先手动启动 OMLX（在 `/Volumes/ovokit2t/AIOVO/` 下查找 OMLX 启动方式）

---

## 8. 已知缺陷与风险

| ID | 缺陷 | 影响 | 状态 |
|----|------|------|------|
| P0-01 | evaluator false-pass | L4/L5 判定不准确 | 已识别 |
| P0-02 | 工具执行后无可见文本 | L4 回答质量 | 已加检测 |
| P0-03 | 模型 stop/unload 后 session 留空 | L1/L5 稳定性 | 已识别 |
| P1-B01 | Character asset pipeline 未实现 | L4-09 | BLOCKED |
| P1-B02 | generateBackground 仅支持 ComfyUI | L4-08 | BLOCKED（无 ComfyUI 时） |
| 运维-1 | Hermes 日志在 `/tmp`，重启丢失 | 全阶段 | 建议迁移 |
| 运维-2 | Shell 工具无 allowlist | 安全风险 | 仅依赖 review gate |

---

## 9. 附录

### 9.1 核心 API 速查

```bash
# Control health
curl http://127.0.0.1:2099/api/health

# Hermes runtime status
curl http://127.0.0.1:2099/api/control/agents/hermes-manager/runtime-status

# Hermes self-check
curl http://127.0.0.1:2099/api/control/agents/hermes-manager/self-check

# Start Hermes
curl -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/runtime-action \
  -H "Content-Type: application/json" \
  -d '{"action":"start","brainSide":"left","config":{}}'

# GameStudio health
curl http://127.0.0.1:1999/api/health

# OMLX models
curl http://127.0.0.1:18888/v1/models -H "Authorization: Bearer omlx123"
```

### 9.2 脚本索引

| 脚本 | 用途 |
|------|------|
| `restart_control.sh` | 启动 Control 控制器 |
| `start_project.sh` | 启动 GameStudio（由 Control 按需调用） |
| `stop_project.sh` | 停止 GameStudio |
| `status_project.sh` | 查看服务状态 |
| `setup_reporter_schedule.sh` | 安装 reporter launchd |
| `reporter.sh` | 状态汇报 |
| `smoke_test_pipeline.sh` | Smoke test 入口 |
| `control_production_test.mjs` | 核心生产测试 |
| `test-dashboard/server.mjs` | 测试仪表盘 |

### 9.3 Hermes 关键路径

```
HERMES_ROOT:              /Volumes/ovokit2t/AIOVO/hermes-agent
HERMES_GATEWAY_SCRIPT:    /Volumes/ovokit2t/AIOVO/hermes-agent/scripts/hermes-gateway
HERMES_VENV_PYTHON:       /Volumes/ovokit2t/AIOVO/hermes-agent/venv/bin/python
HERMES_RUNTIME_PID_FILE:  /tmp/gamestudio-hermes-gateway.pid
HERMES_RUNTIME_LOG_FILE:  /tmp/gamestudio-hermes-gateway.log
HERMES_CONTROL_CONFIG:    config/hermes/manager.left-brain.json
```

### 9.4 验证清单

#### Control + Hermes 验证

- [ ] `./restart_control.sh` 成功
- [ ] `curl :2099/api/health` → ok
- [ ] `curl :8870` → HTTP 200
- [ ] 左脑配置已保存
- [ ] Preflight 通过
- [ ] Hermes 已启动：`curl :8742/v1/models` → data 数组
- [ ] OMLX 可访问：`curl :18888/v1/models` → data 数组
- [ ] `GET /self-check` → ok

#### GameStudio Bootstrap 验证

- [ ] Chat 发送"启动 GameStudio" → classify 为 gamestudio_bootstrap_execute
- [ ] `step_gamestudio_ensure_running` → ok（若未运行则自动调用 start_project.sh）
- [ ] `step_gamestudio_open_editor` → ok
- [ ] `step_gamestudio_self_check` → ok
- [ ] Bootstrap answer 显示"GameStudio 已就绪"

#### 生产任务验证

- [ ] Chat 发送"创建一个互动故事" → classify 为 story_workflow_execute
- [ ] project 创建成功
- [ ] scripts candidate 生成成功
- [ ] blueprint 编译成功
- [ ] compose 编译成功
- [ ] validate 通过
- [ ] export 成功

---

*本文档基于源码阅读（controlServerCore.js, runtimeRoutes.js, gameStudioBootstrapWorkflows.js, storyProductionWorkflows.js, requestClassificationRules.js, promptBuilders.js, control-console/useControlConsoleApp.ts）和实际执行生成。*
