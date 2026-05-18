# Control → Hermes → OMLX → GameStudio 完整驱动链路文档

> 本文档是 control 平面驱动 GameStudio 生产 H5 交互故事的**权威链路说明**。涵盖从启动到生产的每个环节的功能、结构、逻辑，并为日志系统提供可靠切入点。
> 更新日期：2026-05-18

---

## 目录

1. [链路拓扑](#1-链路拓扑)
2. [启动流程](#2-启动流程)
3. [一键启动完整链路](#3-一键启动完整链路)
4. [模型切换完整链路](#4-模型切换完整链路)
5. [OMLX 独立运行契约](#5-omlx-独立运行契约)
6. [Story Production 工作流](#6-story-production-工作流)
7. [模型路由契约](#7-模型路由契约)
8. [Control Server ↔ GameStudio Server 通信契约](#8-control-server--gamestudio-server-通信契约)
9. [记忆回写契约](#9-记忆回写契约)
10. [日志系统与切入点](#10-日志系统与切入点)
11. [错误处理与降级策略](#11-错误处理与降级策略)
12. [已知缺陷清单](#12-已知缺陷清单)
13. [验证检查清单](#13-验证检查清单)
14. [附录：关键文件索引](#14-附录关键文件索引)

---

## 1. 链路拓扑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 启动层                                                                       │
│ ┌─────────────────┐     ┌──────────────────┐                                │
│ │ restart_control │────▶│ control-server   │────┐                          │
│ │      .sh        │     │   (Hono, 2099)   │    │                          │
│ └─────────────────┘     └──────────────────┘    │                          │
│                          │                      │    ┌──────────────────┐   │
│                          ▼                      │    │ control-console  │   │
│ 运行层              ┌─────────────┐             └───▶│   (Vue3, 8870)   │   │
│ ┌──────────┐       │   Hermes    │                  └──────────────────┘   │
│ │  OMLX    │◀─────│  Gateway    │                                         │
│ │(18888)   │       │  (8742)     │                                         │
│ └────┬─────┘       └─────────────┘                                         │
│      │                     ▲                                               │
│      │         ┌───────────┘                                               │
│      │         │ direct transport                                           │
│      │         ▼                                                           │
│      │    ┌──────────────────┐                                             │
│      └───▶│ GameStudio Server│                                             │
│           │   (Hono, 1999)   │                                             │
│           └────────┬─────────┘                                             │
│                    ▼                                                       │
│           ┌──────────────────┐                                             │
│           │ storage/projects/│                                             │
│           │   (真相源)        │                                             │
│           └──────────────────┘                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 分层职责

| 层级 | 地址 | 职责 | 由谁启动 |
|------|------|------|----------|
| **Control Console** | `http://127.0.0.1:8870` | UI 操作界面：chat、reasoning review、生命周期按钮、引擎配置 | `restart_control.sh` |
| **Control Server** | `http://127.0.0.1:2099` | 编排中枢：请求分类、session 管理、质量门禁、workflow 执行 | `restart_control.sh` |
| **Hermes Gateway** | `http://127.0.0.1:8742/v1` | Agent 运行时：注入记忆、调用模型、返回结构化回答 | Control Server 一键启动 |
| **OMLX** | `http://127.0.0.1:18888/v1` | 本地模型推理服务（OpenAI-compatible） | 独立进程，Control 负责检测状态并管理模型加载/卸载 |
| **GameStudio Server** | `http://127.0.0.1:1999` | 业务后端：项目 CRUD、编译、校验、资产生成、导出 | `start_project.sh` |
| **Storage** | `storage/projects/` | 项目产物真相源 | — |

---

## 2. 启动流程

### 2.1 正确的启动顺序

```
Step 1: 启动 OMLX（独立服务）
  └─▶ oMLX.app / python3 -m omlx.cli serve --port 18888
  └─▶ 验证: curl http://127.0.0.1:18888/health
  └─▶ 若未启动：Control 自检时会检测到并提示

Step 2: 启动 GameStudio（业务平面）
  └─▶ ./start_project.sh --detached
  └─▶ 启动 server:1999 + editor:8868
  └─▶ 验证: curl http://127.0.0.1:1999/api/health

Step 3: 启动 Control 平面
  └─▶ ./restart_control.sh
  └─▶ 启动 control-server:2099 + control-console:8870
  └─▶ 验证: curl http://127.0.0.1:2099/api/health

Step 4: 一键启动 Hermes
  └─▶ Control Console UI: "⚡ 一键启动 (保存→自检→启动)"
  └─▶ 或调用 API: POST /api/control/agents/hermes-manager/runtime-action
  └─▶ 自检时会检测 OMLX 状态 → 加载模型 → 启动 Hermes
  └─▶ 验证: curl http://127.0.0.1:8742/v1/models
```

### 2.2 `restart_control.sh` 详细行为

**文件**: `scripts/lifecycle/restart_control.sh`（137 行 Bash）

| 阶段 | 行为 | 日志 |
|------|------|------|
| 环境检查 | 查找 node 二进制（优先 `/opt/homebrew/bin/node`） | 控制台输出 |
| 端口清理 | 关闭占用 2099/8870 的旧进程（SIGTERM → SIGKILL） | 控制台输出 |
| 启动 control-server | `env CONTROL_SERVER_PORT=2099 node apps/control-server/src/index.js` | `.run/control-server.log` |
| 等待就绪 | 轮询 `GET http://127.0.0.1:2099/api/health`（最多 30s） | 控制台输出 |
| 写入 PID | `lsof -tiTCP:2099` → `.run/control-server.pid` | — |
| 启动 control-console | `npm --workspace @game-studio/control-console run dev -- --port 8870` | `.run/control-console.log` |
| 等待就绪 | 轮询 `GET http://127.0.0.1:8870`（最多 30s） | 控制台输出 |
| 写入 PID | `lsof -tiTCP:8870` → `.run/control-console.pid` | — |

**日志埋点建议**:
```
[LAUNCH][control-server] pid={pid} port=2099 status=ready
[LAUNCH][control-console] pid={pid} port=8870 status=ready
[LAUNCH][complete] all_control_services_ready
```

---

## 3. 一键启动完整链路

### 3.1 链路概览

```
用户点击 "⚡ 一键启动"
  ↓
ControlConsoleMainPanels.vue @click="smartStartHermes"
  ↓
composables/useControlConsoleApp.ts smartStartHermes()
  ├─ Step 1: saveLeftBrainConfig()
  │     ↓ PUT /api/control/agents/{agentId}/config
  │     ↓ configRoutes.js:698 mergeHermesControlConfig → setHermesControlConfig
  │     ↓ 写入 config/hermes/manager.left-brain.json
  │     ↓ 更新 control state (config.saved=true, preflight.ready=false)
  │     ↓ appendHermesLog('[CONFIG][SAVE] model=... provider=...')
  │
  ├─ Step 2: runLeftBrainPreflight()
  │     ↓ POST /api/control/agents/{agentId}/preflight-check
  │     ↓ configRoutes.js:669 buildHermesPreflight()
  │     ↓ 检查项：OMLX 连通性、模型列表、模型存在性、记忆文件、skills、context window
  │     ↓ 更新 control state (preflight.ready, model.inspection)
  │     ↓ appendHermesLog('[PREFLIGHT] ...')
  │
  └─ Step 3: toggleHermesRuntime('left')
        ↓ POST /api/control/agents/{agentId}/runtime-action
        ↓ runtimeRoutes.js:77
        ├─ 验证 config fingerprint（必须已保存）
        ├─ 验证 readiness（记忆文件、skills 等）
        ├─ buildHermesPreflight()（再次自检）
        ├─ loadProviderModel() → OMLX POST /admin/api/models/{model}/load
        ├─ inspectProviderModelState() → OMLX GET /v1/models/status
        ├─ startHermesRuntime() → spawn Python hermes-gateway
        │     ├─ 注入环境变量：记忆文件路径、API 配置、技能根目录
        │     ├─ 等待 API 就绪：poll GET http://127.0.0.1:8742/v1/models
        │     └─ 启动 log watcher：poll /tmp/gamestudio-hermes-gateway.log
        └─ 更新 control state (runtime.state='running')
```

### 3.2 Step 1: 保存配置（详细逻辑）

**UI 函数**: `useControlConsoleApp.ts:1386 saveLeftBrainConfig()`

**API**: `PUT /api/control/agents/{agentId}/config`

**Server Handler**: `configRoutes.js:698`

**输入**: `LeftBrainConfigPayload`
```ts
{
  provider: "omlx",              // 推理平台
  baseUrl: "http://127.0.0.1:18888/v1",
  model: "Qwen3.6-35B-A3B-4bit", // 运行模型
  shortTerm: { minContextTokens: 65536 },
  memory: {
    agentDefinitionFile: "ai/AGENTS.md",
    userFile: "ai/USER.md",
    memoryFile: "ai/MEMORY.md",
    longTasksFile: "ai/memory/LONG_TASKS.md",
    statusFile: "ai/memory/STATUS.md",
    taskQueueFile: "ai/memory/TASK_QUEUE.md",
    decisionsFile: "ai/memory/DECISIONS.md",
    dailyLogDir: "ai/memory",
    skillRoot: "config/hermes/skills"
  },
  skills: { skillRoot, skillFiles: string[] },
  brains: { rightBrainEnabled: false }
}
```

**处理逻辑**:
1. `mergeHermesControlConfig(current, body)` — 合并新旧配置
2. `setHermesControlConfig(nextConfig)` — 持久化到 `config/hermes/manager.left-brain.json`
3. 重置 preflight 状态：`ready: false`（强制重新自检）
4. 计算 config fingerprint 用于后续启动验证

**输出**: `{ ok: true, config: nextConfig, readiness, state }`

**日志埋点（已有）**:
```
[CONFIG][SAVE] model={model} provider={provider}
```

### 3.3 Step 2: 自检（详细逻辑）

**UI 函数**: `useControlConsoleApp.ts:1527 runLeftBrainPreflight()`

**API**: `POST /api/control/agents/{agentId}/preflight-check`

**Server Handler**: `configRoutes.js:669`

**核心函数**: `buildHermesPreflight(config, { appendLogs })`

**检查项清单**:

| # | 检查项 | 通过标准 | 失败影响 |
|---|--------|----------|----------|
| 1 | OMLX 连通性 | `GET /v1/models` 返回 200 | 无法加载模型 |
| 2 | 模型存在性 | 目标模型在 OMLX 模型列表中 | 无法启动 Hermes |
| 3 | 记忆文件 | `ai/AGENTS.md` 等文件存在且可读 | 无法注入记忆 |
| 4 | Skills 目录 | `config/hermes/skills/` 存在且非空 | 无法注入技能 |
| 5 | Context Window | `minContextTokens` <= 模型最大上下文 | 可能导致 OOM |
| 6 | API Key | `LOCALOXML_API_KEY` 或环境变量已设置 | OMLX 返回 401 |

**输出**: `PreflightResult`
```ts
{
  ready: boolean,
  checkedAt: string,
  selectedModel: string,      // 实际选中的模型（可能因 fallback 改变）
  models: string[],           // 可用模型列表
  inspection: ModelInspection,// 模型详细信息
  checks: PreflightCheck[],   // 每项检查的详细结果
  readiness: { ready: boolean, items: ReadinessItem[] }
}
```

**日志埋点（已有）**:
```
[PREFLIGHT] OMLX connected, {n} models discovered
[PREFLIGHT] selectedModel={model}
[PREFLIGHT] memoryFiles={n} skills={n}
[PREFLIGHT][ERROR] {checkLabel}: {detail}
```

### 3.4 Step 3: 启动 Hermes Runtime（详细逻辑）

**UI 函数**: `useControlConsoleApp.ts:1693 toggleHermesRuntime('left')`

**API**: `POST /api/control/agents/{agentId}/runtime-action`

**Server Handler**: `runtimeRoutes.js:77`

**前置条件（严格门禁）**:
1. `configFingerprint === persistedFingerprint`（配置已保存）
2. `readiness.ready === true`（自检通过）
3. `preflight.ready === true`（预检通过）
4. `runtimeActionInFlight === null`（无并发操作）

**启动流程**:

```
1. buildHermesPreflight(existing, { appendLogs: true })
   └─▶ 再次运行完整预检

2. loadProviderModel({ provider, baseUrl, model })
   ├─▶ 仅对 "omlx" provider 生效
   ├─▶ createProviderAdminSession() → POST /admin/api/login
   ├─▶ POST /admin/api/models/{model}/load
   ├─▶ waitForProviderModelLoadState() → 轮询 GET /v1/models/status
   │     └─▶ 最多 20 次，间隔 500ms，直到 loaded=true && is_loading=false
   └─▶ 返回 { ok, attempted, detail }

3. inspectProviderModelState({ provider, baseUrl, model })
   └─▶ GET /v1/models/status → 返回模型加载状态、上下文窗口大小等

4. updateHermesControlState()
   └─▶ 更新 preflight + model 状态快照

5. startHermesRuntime()
   ├─▶ spawn(getHermesPython(), [HERMES_GATEWAY_SCRIPT, 'run'], { detached: true })
   │     └─▶ 实际命令: python scripts/hermes-gateway run
   │     └─▶ CWD: /Volumes/ovokit2t/AIOVO/hermes-agent
   │     └─▶ 环境变量注入:
   │         ├─ HERMES_HOME, HERMES_MODEL, HERMES_PROVIDER, HERMES_BASE_URL
   │         ├─ API_SERVER_ENABLED=true, API_SERVER_HOST=127.0.0.1, API_SERVER_PORT=8742
   │         ├─ GAMESTUDIO_AGENT_DEFINITION_FILE → ai/AGENTS.md
   │         ├─ GAMESTUDIO_PROJECT_MEMORY_FILE → ai/MEMORY.md
   │         ├─ GAMESTUDIO_STATUS_FILE → ai/memory/STATUS.md
   │         ├─ GAMESTUDIO_TASK_QUEUE_FILE → ai/memory/TASK_QUEUE.md
   │         ├─ GAMESTUDIO_DECISIONS_FILE → ai/memory/DECISIONS.md
   │         ├─ GAMESTUDIO_SKILL_ROOT → config/hermes/skills
   │         ├─ OPENAI_BASE_URL, LOCALOXML_BASE_URL, STUDIO_AI_BASE_URL
   │         └─ OPENAI_API_KEY, LOCALOXML_API_KEY, STUDIO_AI_API_KEY
   ├─▶ waitForHermesApiReady() → 轮询 GET http://127.0.0.1:8742/v1/models
   │     └─▶ 最多 30 次，间隔 1000ms
   ├─▶ 启动 log watcher: pollHermesGatewayLog()
   │     └─▶ 轮询 /tmp/gamestudio-hermes-gateway.log，检测故障模式
   └─▶ 写入 PID 文件: /tmp/gamestudio-hermes-gateway.pid

6. updateHermesControlState()
   └─▶ 更新 runtime.state = 'running'
```

**日志埋点（已有）**:
```
[START] Preparing left-brain model preflight
[START] Loading provider model before runtime start: {model}
[START][ERROR] Provider load failed: {detail}
[START][OK] Model ready: {model}
[START] Launching Hermes runtime
[START][OK] Started {side} brain binding to {model}
[RESTART] Launching Hermes runtime after full restart
[RESTART][OK] Restarted {side} brain binding to {model}
```

**日志埋点建议补充**:
```
[START][DETAIL] hermes_pid={pid} gateway_port=8742
[START][DETAIL] memory_injection={fileCount} files
[START][DETAIL] provider_load_time_ms={duration}
[START][DETAIL] api_ready_time_ms={duration}
[START][WARN] api_ready_timeout, fallback_to_check_pid
```

---

## 4. 模型切换完整链路

### 4.1 链路概览

```
用户选择新模型，点击 "切换并应用"
  ↓
ControlConsoleMainPanels.vue @click="switchLeftBrainModel"
  ↓
composables/useControlConsoleApp.ts switchLeftBrainModel()
  ↓ POST /api/control/agents/{agentId}/switch-model
  ↓ runtimeRoutes.js:260
    ├─ 检查：无活跃 reasoning session（防止切换中请求中断）
    ├─ 检查：目标模型非空
    ├─ 若模型未变：仅同步 routing 绑定，返回
    ├─ buildHermesPreflight(nextConfig) — 目标模型预检
    ├─ 若 runtime 运行中：stopHermesRuntime() — 停止 Hermes
    ├─ unloadProviderModel(old) — 卸载旧模型
    │     ├─ POST /v1/models/{oldModel}/unload
    │     └─ 轮询直到 loaded=false
    ├─ loadProviderModel(new) — 加载新模型
    │     ├─ POST /admin/api/models/{newModel}/load
    │     └─ 轮询直到 loaded=true
    ├─ inspectProviderModelState(new) — 检查新模型状态
    ├─ setHermesControlConfig(nextConfig) — 持久化新配置
    ├─ 若之前运行中：startHermesRuntime() — 重启 Hermes
    └─ 若任何步骤失败：自动回滚到旧配置 + 旧模型 + 重启 runtime
```

### 4.2 详细逻辑

**UI 函数**: `useControlConsoleApp.ts:1552 switchLeftBrainModel()`

**API**: `POST /api/control/agents/{agentId}/switch-model`

**Server Handler**: `runtimeRoutes.js:260`

**前置条件**:
1. `runtimeActionInFlight === null`（无并发操作）
2. `listActiveReasoningExecutions().length === 0`（无活跃推理）
3. `nextConfig.model` 非空

**核心步骤**:

| # | 步骤 | 函数 | 成功标准 | 失败行为 |
|---|------|------|----------|----------|
| 1 | 目标模型预检 | `buildHermesPreflight(nextConfig)` | `preflight.ready === true` | 返回 409，阻止切换 |
| 2 | 停止 Hermes | `stopHermesRuntime()` | PID 被清除 | 继续执行（尝试卸载/加载） |
| 3 | 卸载旧模型 | `unloadProviderModel({provider,baseUrl,model:old})` | `loaded === false` | 抛出异常，进入回滚 |
| 4 | 加载新模型 | `loadProviderModel({provider,baseUrl,model:new})` | `loaded === true` | 抛出异常，进入回滚 |
| 5 | 检查新模型 | `inspectProviderModelState({provider,baseUrl,model:new})` | 返回模型状态 | 抛出异常，进入回滚 |
| 6 | 保存配置 | `setHermesControlConfig(nextConfig)` | 文件写入成功 | 抛出异常，进入回滚 |
| 7 | 重启 Hermes | `startHermesRuntime()` | API 就绪 | 抛出异常，进入回滚 |

**回滚机制**（`catch` 块）:
```
1. setHermesControlConfig(currentConfig) — 恢复旧配置
2. buildHermesPreflight(currentConfig) — 旧配置预检
3. loadProviderModel({provider,baseUrl,model:old}) — 重新加载旧模型
4. inspectProviderModelState({provider,baseUrl,model:old}) — 检查旧模型
5. updateHermesControlState() — 更新状态为回滚
6. 若之前运行中：startHermesRuntime() — 重启 Hermes
7. 返回 { ok: false, error: 'model_switch_failed', recovered: true/false }
```

**日志埋点（已有）**:
```
[MODEL][SWITCH] validating target={provider}/{model}
[MODEL][SWITCH] stopping runtime before switching target={provider}/{model}
[MODEL][SWITCH] starting runtime on target={provider}/{model}
[MODEL][SWITCH][OK] target={provider}/{model} restarted={true/false}
[MODEL][SWITCH][ERROR] target={provider}/{model} detail={error}
[MODEL][SWITCH][RECOVERED] detail={recoveryDetail}
[MODEL][SWITCH][RECOVERY_ERROR] detail={recoveryDetail}
```

**日志埋点建议补充**:
```
[MODEL][SWITCH][DETAIL] unload_old_time_ms={duration} unload_ok={ok}
[MODEL][SWITCH][DETAIL] load_new_time_ms={duration} load_ok={ok}
[MODEL][SWITCH][DETAIL] memory_before_unload_mb={mem}
[MODEL][SWITCH][DETAIL] memory_after_load_mb={mem}
```

### 4.3 模型加载/卸载 API 契约

**OMLX Admin API**:

| 操作 | 端点 | Auth | 请求体 | 响应 |
|------|------|------|--------|------|
| Admin 登录 | `POST /admin/api/login` | API Key in body | `{ api_key }` | Session cookie |
| 加载模型 | `POST /admin/api/models/{model}/load` | Admin cookie | — | `{ ok, detail }` |
| 卸载模型 | `POST /v1/models/{model}/unload` | Bearer token | — | `{ ok, detail }` |
| 模型状态 | `GET /v1/models/status` | Bearer token | — | `{ loaded, is_loading, ... }` |

**注意**: 加载和卸载使用**不同的认证机制**和**不同的 base path**（`/admin/api` vs `/v1`）。这是 OMLX 的设计，代码已正确适配。

---

## 5. OMLX 独立运行契约

### 5.1 核心原则

> **OMLX 是独立进程，通常由用户手动启动（oMLX.app）。Control Server 不自启动 OMLX 进程，但负责：检测 OMLX 是否运行、管理模型加载/卸载、强制执行单模型约束。**

### 5.2 OMLX 启动方式

```bash
# 方式 1：通过 macOS App 启动
open -a oMLX

# 方式 2：命令行启动
/Applications/oMLX.app/Contents/MacOS/python3 -m omlx.cli serve \
  --base-path /Volumes/ovokit2t/ollama/models/.omlx \
  --port 18888
```

**Control 的 OMLX 检测**：在 `buildHermesPreflight()` 中，通过 `fetchLocalModelCatalog()` 调用 `GET /v1/models` 检测 OMLX 是否可达。若不可达，自检失败，阻止后续启动。

### 5.3 OMLX 健康状态

```bash
curl http://127.0.0.1:18888/health
```

**返回示例**:
```json
{
  "status": "healthy",
  "default_model": "gpt-oss-20b-MXFP4-Q8",
  "engine_pool": {
    "model_count": 7,
    "loaded_count": 1,
    "max_model_memory": 24739011625,
    "current_model_memory": 12680017946
  }
}
```

### 5.4 Control Server 对 OMLX 的管理范围

| 能力 | 是否管理 | 说明 |
|------|----------|------|
| 启动 OMLX 进程 | ❌ 否 | 由用户手动启动 oMLX.app |
| 停止 OMLX 进程 | ❌ 否 | 不可通过 Control 停止 |
| 检测 OMLX 状态 | ✅ 是 | `buildHermesPreflight()` → `fetchLocalModelCatalog()` |
| 加载模型 | ✅ 是 | `loadProviderModel()` → OMLX Admin API |
| 卸载模型 | ✅ 是 | `unloadProviderModel()` → OMLX API |
| **单模型约束** | ✅ **是** | `loadProviderModel()` 加载前自动卸载其他已加载模型 |
| 查询模型列表 | ✅ 是 | `fetchLocalModelCatalog()` → OMLX `/v1/models` |
| 查询模型状态 | ✅ 是 | `inspectProviderModelState()` → OMLX `/v1/models/status` |
| 配置 OMLX 参数 | ❌ 否 | OMLX 配置在 `~/.omlx/settings.json`，不由 Control 管理 |

### 5.5 M2 32GB 内存下的 OMLX 行为

**当前加载模型**: `gpt-oss-20b-MXFP4-Q8`（约 11.8 GB）

**目标模型**: `Qwen3.6-35B-A3B-4bit`（约 19.95 GB 权重 + KV cache）

**问题**: `direct` transport 绕过 Hermes 的模型切换层，OMLX 在已有模型驻留时尝试加载第二个大模型 → OOM。

**当前系统状态**:
- 空闲内存: ~73 MB（极低）
- Swap 已使用: 48 MB
- 内存压缩器活跃: ~8.4 GB 数据被压缩

**配置建议**:
```json
// config/hermes/manager.left-brain.json
{
  "shortTerm": {
    "minContextTokens": 16384  // 从 65536 降低，减少 KV cache
  }
}

// ~/.omlx/settings.json（或 OMLX 配置）
{
  "model": {
    "max_model_memory": "20GB"
  },
  "cache": {
    "hot_cache_max_size": "4GB"
  }
}
```

---

## 6. Story Production 工作流

### 6.1 完整流程（19 步）

```
Phase 1: 项目初始化
  1. story_create_project              → POST /api/projects/ai/create

Phase 2: 脚本生成
  2. story_generate_scripts_candidate  → internal:hermes/story.scripts.candidate (direct OMLX)
  3. story_configure_project           → PUT /api/projects/:id

Phase 3: 蓝图编译
  4. story_compile_blueprint           → POST /api/projects/:id/compile/blueprint
  5. story_validate_blueprint          → POST /api/projects/:id/validate/blueprint
  6. story_review_blueprint_agent      → internal:hermes/story.blueprint.review (direct OMLX)
  7. story_fix_scripts                 → POST /api/projects/:id/ai/fix/scripts
  8. story_compile_blueprint (retry)   → POST /api/projects/:id/compile/blueprint
  9. story_validate_blueprint (retry)  → POST /api/projects/:id/validate/blueprint

Phase 4: 合成与圣经
  10. story_compile_compose            → POST /api/projects/:id/compile/compose
  11. story_generate_story_bible       → POST /api/projects/:id/ai/story/bible
  12. story_generate_asset_plan        → POST /api/projects/:id/ai/story/assets/plan

Phase 5: 资产生成（当前主要阻塞点）
  13. story_lock_asset_references      → POST /api/projects/:id/ai/story/assets/reference
  14. story_select_asset_references    → POST /api/projects/:id/ai/story/assets/reference/select
  15. story_generate_asset_candidate   → POST /api/projects/:id/ai/background

Phase 6: 渲染与验证
  16. story_render_scenes              → (未实现完整链路)
  17. story_validate_project           → POST /api/projects/:id/validate/blueprint

Phase 7: 导出
  18. story_export_project             → POST /api/projects/:id/export
  19. story_generate_default_answer    → 总结报告
```

### 6.2 当前停滞点分析

`state/story-production/current-project.json`:
```json
{
  "projectId": "e505a52d-b99b-4768-880c-ebe69ae5e0c3",
  "action": "story_validate_project",
  "updatedAt": "2026-05-12T10:19:17.194Z"
}
```

**停滞原因**:
1. `getAiStatus()` 数据契约断裂（已修复）→ `imageEnabled` 为 `false`，第 15 步被跳过
2. 第 17 步后无明确的后续步骤定义
3. `MAX_MODEL_CALLS_PER_SESSION = 8` 可能已超限

---

## 7. 模型路由契约

Control Server 通过 `requestHermesChatCompletion()` 发送模型请求，支持两种 transport：

| Transport | 目标 | 使用场景 | 模型 |
|-----------|------|----------|------|
| `hermes` | `http://127.0.0.1:8742/v1` (Hermes gateway) | Chat、Reasoning Plan、Reasoning Answer、Quality Gate | `hermes-agent` |
| `direct` | `http://127.0.0.1:18888/v1` (OMLX directly) | Story Scripts Candidate、Story Blueprint Review | `Qwen3.6-35B-A3B-4bit` |

### 7.1 路由决策逻辑

```
resolveModelRouteForPhase(binding, phase, options)
  ├─ 检查 binding.workflow.modelRouting.actionRoutes[phase]
  ├─ 检查 binding.workflow.modelRouting.phaseRoutes[phase]
  └─ 回退到 binding.workflow.modelRouting.defaultRoute

若 provider/baseUrl/model 与 fallback binding 不同，
transport 自动升级为 direct
```

### 7.2 Transport 选择

所有 phase routes 已统一使用 `transport: "hermes"`，通过 Hermes Gateway 统一管理模型调用。这确保了：
1. 单模型约束在 Gateway 层得到执行
2. 所有模型加载/卸载都经过 Control 的 `loadProviderModel()` / `unloadProviderModel()`
3. 日志和可观测性统一

**历史问题**: 之前 `direct` transport 会直接调用 OMLX，绕过 Hermes 的模型管理层，在 M2 32GB 上容易导致 OOM。此问题已通过统一 transport 解决。

---

## 8. Control Server ↔ GameStudio Server 通信契约

### 8.1 基础约定

- **Base URL**: `http://127.0.0.1:1999`（可通过 `GAMESTUDIO_SERVER_BASE_URL` 覆盖）
- **CORS**: `origin: '*'`，无跨域障碍
- **超时**: 默认 120s，AI 生成端点可覆盖为 300s
- **返回结构**: `{ ok, status, endpoint, url, data, error?, message?, retryable? }`

### 8.2 Client 方法清单

| 方法 | 端点 | 用途 |
|------|------|------|
| `getHealth` | `GET /api/health` | 健康检查 |
| `getStudioSettings` | `GET /api/studio/settings` | 读取 studio 配置 |
| `updateStudioSettings` | `PUT /api/studio/settings` | 写入 studio 配置 |
| `getAiStatus` | `GET /api/ai/status` | AI 状态快照（已修复契约适配） |
| `listProjects` | `GET /api/projects` | 列出项目 |
| `createProject` | `POST /api/projects` | 创建空白项目 |
| `createAiProject` | `POST /api/projects/ai/create` | AI 创建项目 |
| `getProject` | `GET /api/projects/:id` | 读取项目 |
| `updateProject` | `PUT /api/projects/:id` | 更新项目 |
| `getScripts` | `GET /api/projects/:id/scripts` | 读取脚本 |
| `putScripts` | `PUT /api/projects/:id/scripts` | 写入脚本 |
| `compileBlueprint` | `POST /api/projects/:id/compile/blueprint` | 编译蓝图 |
| `validateBlueprint` | `POST /api/projects/:id/validate/blueprint` | 校验蓝图 |
| `reviewBlueprint` | `POST /api/projects/:id/ai/review/blueprint` | AI 审查蓝图 |
| `fixScripts` | `POST /api/projects/:id/ai/fix/scripts` | AI 修复脚本 |
| `compileCompose` | `POST /api/projects/:id/compile/compose` | 合成故事 |
| `exportProject` | `POST /api/projects/:id/export` | 导出 H5 |
| `generateBackground` | `POST /api/projects/:id/ai/background` | 生成背景图 |
| `createStoryBible` | `POST /api/projects/:id/ai/story/bible` | 生成故事圣经 |
| `createStoryAssetPlan` | `POST /api/projects/:id/ai/story/assets/plan` | 生成资产计划 |
| `generateStoryAssetReference` | `POST /api/projects/:id/ai/story/assets/reference` | 生成资产参考 |
| `selectStoryAssetReference` | `POST /api/projects/:id/ai/story/assets/reference/select` | 选择资产参考 |
| `storyLockTest` | `POST /api/projects/:id/ai/story/lock/test` | 故事板锁定测试 |
| `preflightImageProvider` | `POST /api/studio/image/preflight` | 图像提供方预检 |

---

## 9. 记忆回写契约

### 9.1 正确行为

每次 reasoning session 结束后，`finalizeReasoningSessionWithQualityGate()` 应：

1. **更新 `ai/memory/STATUS.md`**:
   - 当前目标（1 个）
   - 阻塞项（如有）
   - 下一步行动（1 个）

2. **更新 `ai/memory/TASK_QUEUE.md`**:
   - 未完成的短任务列表（3-5 个）
   - 每个任务的状态：pending / in_progress / blocked / done

3. **更新 `ai/memory/LONG_TASKS.md`**:
   - 长任务方向（1-2 个）
   - 当前进度

### 9.2 当前状态（断裂）

| 文件 | 应有内容 | 实际内容 |
|------|----------|----------|
| `STATUS.md` | 当前目标、阻塞、下一步 | `Refresh ai/memory/STATUS.md after this run...` |
| `TASK_QUEUE.md` | 活跃短任务列表 | `Rewrite ai/memory/TASK_QUEUE.md so it keeps only active short tasks...` |
| `LONG_TASKS.md` | 长任务状态 | `Refresh ai/memory/LONG_TASKS.md so it reflects...` |

**后果**: Hermes Gateway 启动时注入这些文件作为上下文，但内容为自指指令。Hermes 无法积累历史知识。

---

## 10. 日志系统与切入点

### 10.1 现有日志体系

| 日志 | 位置 | 格式 | 内容 |
|------|------|------|------|
| **Hermes Runtime Log** | `state/agent-runtime/hermes-runtime.log` | 文本 `[ISO8601] [TAG] message` | 配置保存、预检、启动、停止、模型切换 |
| **Agent Runtime Events** | `state/agent-runtime-events.jsonl` | JSON Lines | 每个 reasoning session 的完整事件流（task_registered, task_started, task_completed, plan_created, review_requested 等） |
| **Control Server Log** | `.run/control-server.log` | 控制台输出 | control-server 启动日志、HTTP 请求日志 |
| **Control Console Log** | `.run/control-console.log` | 控制台输出 | Vite dev server 日志 |
| **Hermes Gateway Log** | `/tmp/gamestudio-hermes-gateway.log` | 文本 | Hermes Python 进程的标准输出/错误 |
| **GameStudio Server Log** | `.run/server.log` | 控制台输出 | 业务后端 HTTP 请求日志 |

### 10.2 Agent Runtime Events 结构

```json
{
  "eventId": "evt_{timestamp}_{random}",
  "sessionId": "reasoning_{timestamp}_{random}",
  "runtimeSessionId": "reasoning_{timestamp}_{random}",
  "type": "task_registered|task_started|task_completed|plan_created|review_requested|...",
  "timestamp": "2026-04-27T10:51:32.959Z",
  "title": "运行任务图任务",
  "summary": "...",
  "data": { /* 事件特定数据 */ },
  "sessionKind": "agent-runtime"
}
```

### 10.3 需要补充的日志切入点

#### A. 启动链路日志（新增）

| 环节 | 建议日志 | 写入位置 |
|------|----------|----------|
| `restart_control.sh` 开始 | `[LAUNCH][control] restart_script_started` | 控制台 + `.run/control-launch.log` |
| control-server 进程启动 | `[LAUNCH][control-server] pid={pid} port=2099` | `.run/control-server.log` |
| control-server API 就绪 | `[LAUNCH][control-server] api_ready time_ms={duration}` | `.run/control-server.log` |
| control-console 进程启动 | `[LAUNCH][control-console] pid={pid} port=8870` | `.run/control-console.log` |
| control-console 就绪 | `[LAUNCH][control-console] ui_ready time_ms={duration}` | `.run/control-console.log` |

#### B. 一键启动链路日志（已有基础上补充）

| 环节 | 建议补充字段 | 写入位置 |
|------|-------------|----------|
| 配置保存 | `[CONFIG][SAVE][DETAIL] fingerprint={hash} file={path}` | Hermes Runtime Log |
| 预检 | `[PREFLIGHT][DETAIL] omlx_response_time_ms={duration} model_count={n}` | Hermes Runtime Log |
| 模型加载 | `[START][DETAIL] load_time_ms={duration} model={model}` | Hermes Runtime Log |
| Hermes 启动 | `[START][DETAIL] hermes_pid={pid} python={path} args={args}` | Hermes Runtime Log |
| API 就绪 | `[START][DETAIL] api_ready_poll_count={n} total_time_ms={duration}` | Hermes Runtime Log |
| 启动完成 | `[START][COMPLETE] session_ready model={model} context_tokens={n}` | Hermes Runtime Log |

#### C. 模型切换链路日志（已有基础上补充）

| 环节 | 建议补充字段 | 写入位置 |
|------|-------------|----------|
| 切换开始 | `[MODEL][SWITCH][DETAIL] from={oldModel} to={newModel}` | Hermes Runtime Log |
| 卸载旧模型 | `[MODEL][SWITCH][DETAIL] unload_time_ms={duration} unload_ok={ok}` | Hermes Runtime Log |
| 加载新模型 | `[MODEL][SWITCH][DETAIL] load_time_ms={duration} load_ok={ok}` | Hermes Runtime Log |
| 内存快照 | `[MODEL][SWITCH][DETAIL] mem_free_mb={mem} mem_pressure={level}` | Hermes Runtime Log |
| 回滚触发 | `[MODEL][SWITCH][ROLLBACK] reason={error} recovering_to={oldModel}` | Hermes Runtime Log |
| 回滚完成 | `[MODEL][SWITCH][ROLLBACK][OK] recovery_time_ms={duration}` | Hermes Runtime Log |

#### D. Story Production 链路日志（新增）

| 环节 | 建议日志 | 写入位置 |
|------|----------|----------|
| Workflow 开始 | `[STORY][WORKFLOW] start projectId={id} total_steps={n}` | Agent Runtime Events |
| Step 执行 | `[STORY][STEP] index={i} action={action} status=start\|ok\|error` | Agent Runtime Events |
| 模型调用 | `[STORY][MODEL] phase={phase} model={model} transport={transport} tokens_in={n} tokens_out={n}` | Agent Runtime Events |
| GameStudio API 调用 | `[STORY][API] endpoint={method} {path} status={httpStatus} time_ms={duration}` | Agent Runtime Events |
| 资产生成 | `[STORY][ASSET] kind={kind} projectId={id} status=started\|completed\|failed` | Agent Runtime Events |
| Workflow 完成 | `[STORY][WORKFLOW] end projectId={id} result=success\|failed` | Agent Runtime Events |

#### E. OMLX 内存监控日志（新增）

| 环节 | 建议日志 | 写入位置 |
|------|----------|----------|
| 内存压力检测 | `[OMLX][MEMORY] free_mb={free} used_mb={used} swap_mb={swap}` | Hermes Runtime Log |
| 模型加载前 | `[OMLX][MEMORY][PRE_LOAD] current_loaded={model} current_memory_gb={gb}` | Hermes Runtime Log |
| 模型加载后 | `[OMLX][MEMORY][POST_LOAD] loaded={model} total_memory_gb={gb}` | Hermes Runtime Log |
| OOM 预警 | `[OMLX][MEMORY][WARN] predicted_oom model={model} required_gb={gb} available_gb={gb}` | Hermes Runtime Log |

---

## 11. 错误处理与降级策略

### 11.1 各层错误处理

| 故障场景 | 当前行为 | 建议改进 |
|----------|----------|----------|
| OMLX 不可达 | 3 次重试后标记失败 | ✅ 保持 |
| Hermes Gateway 崩溃 | 无感知，下次状态检查才发现 | ❌ 需注册 `child.on('exit')` 自动重启 |
| 模型加载失败 | 返回 409，阻止启动 | ✅ 保持 |
| 模型切换失败 | 自动回滚旧配置+旧模型 | ✅ 保持 |
| Config 未保存 | 返回 409 `config_not_saved` | ✅ 保持 |
| Preflight 失败 | 返回 409 `preflight_failed` | ✅ 保持 |
| 活跃 reasoning 中切换模型 | 返回 409 `reasoning_in_progress` | ✅ 保持 |

### 11.2 降级路径

```
OMLX (18888) 不可用
  → 若配置了 OpenAI API Key → 降级到 OpenAI
  → 若配置了 Ollama → 降级到 Ollama
  → 无任何可用模型 → 返回 deterministic fallback

Qwen3.6-35B-A3B-4bit 因内存无法加载
  → 降级到 gpt-oss-20b-MXFP4-Q8（已加载，约 11.8 GB）
  → 或降级到 Qwen3.5-9B-MLX-4bit（约 5.5 GB）
```

---

## 12. 已知缺陷清单

| # | 缺陷 | 严重度 | 影响 | 修复方向 |
|---|------|--------|------|----------|
| 1 | `getAiStatus()` 数据契约断裂 | 🔴 | 资产生成被跳过 | ✅ **已修复**（client 适配） |
| 2 | 记忆文件为空/自指 | 🔴 | Hermes 无历史上下文 | 在 session finalize 中写入记忆 |
| 3 | `direct` transport 绕过模型卸载 | 🔴 | M2 32GB OOM | ✅ **已修复**：统一改为 `hermes` transport |
| 4 | `story_validate_project` 无对应端点 | 🟡 | 仅校验 blueprint | 新增 `POST /api/projects/:id/validate/project` |
| 5 | `MAX_MODEL_CALLS_PER_SESSION = 8` | 🟡 | 完整 workflow 容易超限 | 提升至 16 或改为环境变量配置 |
| 6 | 硬编码 ComfyUI 路径 | 🟡 | 换机器后路径失效 | 改为从 env/studio settings 读取 |
| 7 | `direct` transport 硬编码模型 | 🟡 | Qwen3.6-35B 不可用时失败 | 支持模型列表探测和 fallback |
| 8 | Server 端 openai.js fallback URL 错误 | 🟢 | localoxml 未配置时打到 OpenAI | 修复 fallback 逻辑 |
| 9 | Hermes 崩溃无自动恢复 | 🟡 | 需手动重启 | 注册 `child.on('exit')` + 自动重启 |
| 10 | 无运行时健康轮询 | 🟡 | 故障发现延迟 | 添加定时 health ping |
| 11 | `pause` 实际上是 `kill` | 🟢 | 非真正暂停 | 文档化或实现 graceful pause |

---

## 13. 验证检查清单

启动链路前，确认以下检查项：

### 13.1 服务就绪检查

- [ ] OMLX (`:18888`) 健康检查通过：`curl http://127.0.0.1:18888/health`
- [ ] OMLX 模型列表可获取：`curl http://127.0.0.1:18888/v1/models`
- [ ] GameStudio Server (`:1999`) 健康检查通过：`curl http://127.0.0.1:1999/api/health`
- [ ] Control Server (`:2099`) 健康检查通过：`curl http://127.0.0.1:2099/api/health`
- [ ] Control Console (`:8870`) 可访问：`curl http://127.0.0.1:8870`

### 13.2 配置检查

- [ ] `config/hermes/manager.left-brain.json` 存在且有效
- [ ] `ai/AGENTS.md` 存在且非空
- [ ] `ai/memory/STATUS.md` 存在
- [ ] `ai/memory/TASK_QUEUE.md` 存在
- [ ] `config/hermes/skills/` 目录存在且非空
- [ ] `.env` 或 `.env.local` 中 `LOCALOXML_API_KEY` 已设置

### 13.3 运行时状态检查

- [ ] `getStudioSettings()` 返回 `effective.enabled.image === true`
- [ ] `getAiStatus()` 返回 `effective.enabled.image === true`（修复后）
- [ ] `preflightResult.ready === true`
- [ ] Hermes Gateway 进程运行中：`ps aux | grep hermes-gateway`
- [ ] Hermes API 就绪：`curl http://127.0.0.1:8742/v1/models`
- [ ] `storage/projects/` 可读写

### 13.4 内存检查（M2 32GB）

- [ ] `vm_stat` 显示空闲内存 > 2GB
- [ ] Swap 使用率 < 1GB
- [ ] OMLX 当前仅加载 1 个模型
- [ ] `hot_cache_max_size` <= 4GB

---

## 14. 附录：关键文件索引

| 文件 | 作用 |
|------|------|
| `scripts/lifecycle/restart_control.sh` | Control 平面启动脚本 |
| `scripts/lifecycle/start_project.sh` | 业务平面启动脚本 |
| `apps/control-server/src/index.js` | Control Server 入口 |
| `apps/control-server/src/server/controlServerCore.js` | Control Server 执行引擎（9855 行） |
| `apps/control-server/src/server/routes/runtimeRoutes.js` | Runtime 启动/停止/切换路由 |
| `apps/control-server/src/server/routes/configRoutes.js` | 配置保存/预检路由 |
| `apps/control-server/src/server/model/modelTaskQueue.js` | 模型任务队列与路由 |
| `apps/control-server/src/server/services/gameStudioServerClient.js` | GameStudio Server 客户端 |
| `apps/control-console/src/composables/useControlConsoleApp.ts` | UI 核心逻辑 |
| `apps/control-console/src/components/ControlConsoleMainPanels.vue` | 引擎配置面板 |
| `apps/server/src/index.js` | GameStudio Server 入口 |
| `apps/server/src/ai/diagnostics.js` | AI 状态快照 |
| `apps/server/src/studio/settings.js` | Studio 配置计算 |
| `config/hermes/manager.left-brain.json` | Hermes 左脑配置 |
| `config/hermes/manager.left-brain.state.json` | Hermes 运行时状态 |
| `ai/memory/STATUS.md` | 当前目标与阻塞 |
| `ai/memory/TASK_QUEUE.md` | 短任务队列 |
| `state/agent-runtime-events.jsonl` | Agent 运行时事件流 |
| `state/agent-runtime-sessions/` | Reasoning session 存储 |
| `state/story-production/current-project.json` | 当前生产项目状态 |
