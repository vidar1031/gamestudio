# Hermes 运行机制与 Control 交互全景文档

> 本文档面向 AI Agent、维护者和后续开发者。目标：让 Hermes 完全理解 GameStudio 工作流，能够自治地跑完故事生产闭环。
>
> 状态：基于当前代码事实（`apps/control-server/src`、`/Volumes/ovokit2t/AIOVO/hermes-agent`）编写，非计划草案。

---

## 目录

1. [Hermes 本质与定位](#1-hermes-本质与定位)
2. [Hermes 运行机制详解](#2-hermes-运行机制详解)
3. [Control 与 Hermes 交互协议](#3-control-与-hermes-交互协议)
4. [Hermes 自治边界](#4-hermes-自治边界)
5. [GameStudio 故事生产工作流](#5-gamestudio-故事生产工作流)
6. [补齐清单：让 Hermes 完全自治](#6-补齐清单让-hermes-完全自治)

---

## 1. Hermes 本质与定位

### 1.1 什么是 Hermes

**Hermes**（项目名 `hermes-agent`）是由 [Nous Research](https://nousresearch.com) 开发的开源 **AI Agent 框架**，用 Python 编写。它是一个完整的自进化智能体系统，支持：

- 多模型接入（OpenAI、Anthropic、Gemini、OpenRouter、本地 OMLX 等任意 OpenAI-compatible 端点）
- 工具调用（Function Calling）闭环
- 多平台消息网关（Telegram、Discord、Slack、WhatsApp、Signal 等）
- 自主技能（Skill）创建与改进
- 跨会话记忆与搜索
- 子代理（Subagent）并行调度

### 1.2 Hermes 在 GameStudio 中的角色

在 GameStudio 架构中，Hermes 被定位为**控制平面（Control Plane）的"左脑"（Planner / 规划师）**：

| 角色 | 职责 |
|------|------|
| **规划师** | 接收用户意图，拆解为可执行步骤计划 |
| **执行协调者** | 通过工具调用与 GameStudio Server 交互，完成项目创建、脚本生成、蓝图编译等操作 |
| **可观测推理引擎** | 支持 reasoning session，每一步都暴露给 Control Console 审核 |

### 1.3 物理部署

| 项目 | 路径 |
|------|------|
| Hermes 源码/运行目录 | `/Volumes/ovokit2t/AIOVO/hermes-agent` |
| Gateway 启动脚本 | `/Volumes/ovokit2t/AIOVO/hermes-agent/scripts/hermes-gateway` |
| Python 解释器 | `/Volumes/ovokit2t/AIOVO/hermes-agent/venv/bin/python` |
| GameStudio 控制配置 | `config/hermes/manager.left-brain.json` |
| GameStudio 控制状态 | `config/hermes/manager.left-brain.state.json` |
| Hermes 运行 PID 文件 | `/tmp/gamestudio-hermes-gateway.pid` |
| Hermes 运行日志 | `/tmp/gamestudio-hermes-gateway.log` |
| GameStudio Agent 记忆 | `ai/`（AGENTS.md、MEMORY.md、memory/ 等） |

---

## 2. Hermes 运行机制详解

### 2.1 Gateway 启动流程

GameStudio 通过 `control-server` 启动 Hermes Gateway，调用链如下：

```text
control-server :: startHermesRuntime()
    └── spawn(pythonPath, [HERMES_GATEWAY_SCRIPT, 'run'], {
            cwd: HERMES_ROOT,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: customEnv
        })
        └── scripts/hermes-gateway :: main() :: run_gateway()
            └── asyncio.run(start_gateway())
                └── gateway/run.py :: start_gateway()
```

**`start_gateway()` 内部阶段**（`gateway/run.py`）：

| 阶段 | 动作 |
|------|------|
| 1. 重复实例防护 | `acquire_gateway_runtime_lock()` 防止同一 `HERMES_HOME` 下多实例 |
| 2. 技能同步 | `sync_skills(quiet=True)` 同步内置 skills |
| 3. 日志初始化 | `setup_logging(mode="gateway")` 设置 `agent.log` / `errors.log` / `gateway.log` |
| 4. 创建 GatewayRunner | `runner = GatewayRunner(config)` |
| 5. 信号处理 | `SIGINT`/`SIGTERM` → shutdown；`SIGUSR1` → restart |
| 6. PID 文件 | `write_pid_file()` + `atexit` 清理 |
| 7. MCP 工具发现 | 异步 `discover_mcp_tools()`，避免阻塞事件循环 |
| 8. 启动 Runner | `await runner.start()` |
| 9. 后台 Cron | 启动 `cron-ticker` 线程处理定时任务 |
| 10. 等待关闭 | `await runner.wait_for_shutdown()` |

**注入的关键环境变量**（Control Server → Hermes）：

- **模型路由**：`HERMES_MODEL`、`HERMES_PROVIDER`、`HERMES_BASE_URL`
- **API Server 配置**：`API_SERVER_ENABLED='true'`、`API_SERVER_HOST='127.0.0.1'`、`API_SERVER_PORT=8742`
- **Agent 记忆文件路径**：`GAMESTUDIO_AGENT_DEFINITION_FILE`、`GAMESTUDIO_PROJECT_MEMORY_FILE`、`GAMESTUDIO_STATUS_FILE`、`GAMESTUDIO_TASK_QUEUE_FILE`、`GAMESTUDIO_DECISIONS_FILE`、`GAMESTUDIO_LONG_TASKS_FILE`
- **Skill 配置**：`GAMESTUDIO_SKILL_ROOT`、`GAMESTUDIO_SKILL_FILES`
- **系统提示**：`HERMES_EPHEMERAL_SYSTEM_PROMPT`
- **代理绕过**：`NO_PROXY` / `no_proxy`（自动包含 `127.0.0.1`、`localhost` 及 provider hostname）

### 2.2 GatewayRunner 生命周期管理

核心类 `GatewayRunner`（`gateway/run.py`）管理以下状态：

| 属性 | 作用 |
|------|------|
| `adapters` | 已连接的平台适配器（GameStudio 使用 `API_SERVER` 适配器） |
| `session_store` | 基于 JSONL/SQLite 的会话持久化 |
| `delivery_router` | 消息路由到正确平台 |
| `_agent_cache` | LRU + TTL 缓存的 `AIAgent` 实例（默认最大 128，空闲 1h 淘汰） |
| `_running_agents` | 当前正在处理消息的会话 |
| `_session_db` | SQLite，用于 `session_search` 和会话元数据 |
| `_pending_approvals` | 待审批的危险命令 |
| `hooks` | 声明式事件钩子注册表 |

**`start()` 启动逻辑**：
1. 安全与配置检查
2. 插件与钩子发现：`discover_plugins()`、`self.hooks.discover_and_load()`
3. 崩溃恢复：`process_registry.recover_from_checkpoint()`
4. 会话挂起：非优雅退出时 `session_store.suspend_recently_active()`
5. 平台连接：遍历 `self.config.platforms`，创建 adapter、设置消息 handler、连接
6. 启动后通知：发送 `/restart` 完成通知
7. 后台任务：会话过期清理、看板任务、断线重连

**消息处理主入口 `_handle_message()`**：
- 插件钩子 `pre_gateway_dispatch`
- 用户鉴权
- 运行中会话优先级处理：`/stop` 中断、`/new` 重置、`/queue` FIFO、`/steer` 注入 steering
- 最终进入 `_handle_message_with_agent()` → `_run_agent()`

**`_run_agent()` 调用链**：
```text
_run_agent()
    ├── _resolve_session_agent_runtime()  # 解析模型/Provider/API_KEY
    ├── 从 _agent_cache 获取或创建 AIAgent
    ├── 注入 context_prompt、history、session_id
    ├── agent.run_conversation()        # 进入 tool calling loop
    └── 处理结果、保存 transcript、发送回复
```

### 2.3 AIAgent 对话循环（Tool Calling Loop）

核心方法：`AIAgent.run_conversation()`（`run_agent.py`）

```text
run_conversation(user_message, system_message, conversation_history, task_id, stream_callback)
    ├── 初始化：_install_safe_stdio()、重置 retry counter、iteration_budget
    ├── 构建消息列表：history + user_message
    ├── 系统提示：从 session_db 读取或 _build_system_prompt()
    ├── 预压缩检查：token >= threshold 时调用 _compress_context()
    ├── 插件 pre_llm_call 钩子：收集 plugin_user_context
    └── 🔄 主循环：while api_call_count < max_iterations and budget > 0
        ├── 1. 检查中断 (self._interrupt_requested)
        ├── 2. 消耗 iteration budget
        ├── 3. step_callback 上报
        ├── 4. drain pending steer
        ├── 5. 构建 api_messages（修复 tool_call 参数、role alternation、注入 memory prefetch + plugin context）
        ├── 6. API 调用：_interruptible_streaming_api_call() 或 _interruptible_api_call()
        ├── 7. 响应处理：validate_response() → 若 assistant_message.tool_calls 存在
        │       └── _execute_tool_calls() → _invoke_tool() → handle_function_call()
        └── 8. 若无 tool_calls → break，生成 final_response
```

**Tool 执行内部**：

单 tool 调用统一入口：`_invoke_tool()`（`run_agent.py`）
- `todo` → `todo_tool()`
- `session_search` → `session_search()`
- `memory` → `memory_tool()` + 通知 `MemoryManager.on_memory_write()`
- `clarify` → `clarify_tool()`
- `delegate_task` → `_dispatch_delegate_task()`
- 外部 memory tools → `MemoryManager.handle_tool_call()`
- 其他 → `handle_function_call()`（来自 `model_tools.py`）

**并发执行**（`_execute_tool_calls_concurrent`）：
- `ThreadPoolExecutor(max_workers=min(len(calls), 8))`
- `contextvars.copy_context()` 传播 ContextVar
- 父线程周期性 `wait(futures, timeout=5.0)` 检查中断

### 2.4 上下文如何组装

System Prompt 构建：`AIAgent._build_system_prompt()` 按**严格顺序**拼接：

| 层级 | 来源 | 内容 |
|------|------|------|
| 1. Agent Identity | `load_soul_md()` 或 `DEFAULT_AGENT_IDENTITY` | SOUL.md 或硬编码身份 |
| 2. Help Guidance | `HERMES_AGENT_HELP_GUIDANCE` | 指向 hermes-agent skill 的文档 |
| 3. Tool Guidance | `MEMORY_GUIDANCE`、`SESSION_SEARCH_GUIDANCE`、`SKILLS_GUIDANCE` | 仅在对应 tool 启用时注入 |
| 4. Tool Enforcement | `TOOL_USE_ENFORCEMENT_GUIDANCE` | 强制模型调用 tool 而非描述 |
| 5. 用户 System Msg | `system_message` 参数 | gateway 或调用方传入 |
| 6. 内置记忆 | `MemoryStore.format_for_system_prompt("memory")` | MEMORY.md 快照 |
| 7. 用户画像 | `MemoryStore.format_for_system_prompt("user")` | USER.md 快照 |
| 8. 外部记忆 | `MemoryManager.build_system_prompt()` | 外部 provider 的 system prompt block |
| 9. Skills | `build_skills_system_prompt()` | 可用 skills 列表与说明 |
| 10. 上下文文件 | `build_context_files_prompt()` | AGENTS.md、.cursorrules 等 |
| 11. 时间戳/元数据 | `hermes_time.now()` | 当前时间、session_id、model、provider |
| 12. 环境提示 | `build_environment_hints()` | WSL/Termux 等环境信息 |
| 13. 平台提示 | `PLATFORM_HINTS[platform]` | telegram/discord 等格式提示 |

**关键设计**：
- `_cached_system_prompt` **按会话缓存**，跨 turn 复用以最大化 prefix cache 命中率（尤其对 Anthropic）。
- `ephemeral_system_prompt` **不在此处拼接**，而是在 API 调用时动态附加，避免污染缓存。
- 所有动态/可变上下文（memory prefetch、plugin context）都注入到 **user message**，绝不修改 system prompt。

### 2.5 工具注册和调用机制

**工具发现**（`model_tools.py` 模块加载时）：
```text
discover_builtin_tools()           # 导入 tools/ 下所有模块
    └── 各工具模块顶部调用 registry.register(name, schema, handler, ...)
discover_plugins()                 # 用户/项目/plugin 工具
```

**工具定义获取**：`get_tool_definitions()`（`model_tools.py`）
1. 根据 `enabled_toolsets` / `disabled_toolsets` 解析要包含的工具名集合
2. 调用 `registry.get_definitions(tools_to_include)`：对每个 tool 执行 `check_fn()` 动态可用性检查
3. 动态 schema 重建（如 `execute_code` 根据当前 sandbox 可用工具重建 schema）
4. `sanitize_tool_schemas()`：兼容 llama.cpp 等本地后端

**工具调用分发**：`handle_function_call()`（`model_tools.py`）
```text
handle_function_call(function_name, function_args, ...)
    ├── coerce_tool_args()                    # 类型强制转换
    ├── pre_tool_call 插件钩子（block 检查）
    ├── registry.dispatch(function_name, ...)   # 查找并执行 handler
    └── post_tool_call / transform_tool_result 插件钩子
```

### 2.6 记忆（Memory）如何注入对话

Hermes 有两套记忆子系统：**内置 MemoryStore** + **外部 MemoryManager**。

#### A. 内置 MemoryStore

**存储**：
- `~/.hermes/memories/MEMORY.md` — Agent 自身观察/知识
- `~/.hermes/memories/USER.md` — 用户偏好/画像

**生命周期**：
1. `AIAgent.__init__()` 创建 `MemoryStore`，调用 `load_from_disk()`
2. 读取两个文件，去重，生成**冻结快照** `_system_prompt_snapshot`
3. `_build_system_prompt()` 将快照注入 system prompt
4. **Mid-session 写入**：`memory_tool` 的 add/replace/remove 会原子写入磁盘，但**不更新 `_cached_system_prompt`**（保护 prefix cache）
5. 下次新 session 启动时，新的 `AIAgent` 会重新 `load_from_disk()`

#### B. 外部 MemoryManager（`agent/memory_manager.py`）

用于接入 LCM、Honcho 等外部记忆后端。

**每 turn 注入流程**：
1. **Turn 开始前**：`self._memory_manager.on_turn_start(turn_count, user_msg)`
2. **Prefetch**：`self._memory_manager.prefetch_all(original_user_message)`
3. **注入用户消息**：`build_memory_context_block(_ext_prefetch_cache)`，格式为 `<memory-context>...</memory-context>`
4. **Turn 结束后同步**：`sync_all()` + `queue_prefetch_all()` 预加载下一轮
5. **Streaming 保护**：`StreamingContextScrubber` 剔除流式输出中的 `<memory-context>` 标签

### 2.7 多平台适配与 GameStudio 的特殊路径

GatewayRunner 通过 `BasePlatformAdapter` 抽象支持多平台：`LOCAL`、`API_SERVER`、`WEBHOOK`、`TELEGRAM`、`DISCORD` 等。

**GameStudio 不走 Telegram/Discord，而是直接管理 Hermes 作为本地子进程**：

1. **Gateway 进程**：`control-server` 通过 `spawn` 启动 `scripts/hermes-gateway run`
2. **API_SERVER 平台**：通过环境变量 `API_SERVER_ENABLED=true` 启用 Hermes 的本地 HTTP API（`127.0.0.1:8742`）
3. **日志监控**：`control-server` 通过 `pollHermesGatewayLog()` 持续 tail `/tmp/gamestudio-hermes-gateway.log`，检测 OMLX 故障
4. **会话管理 bypass**：GameStudio 自己管理 chat history 文件，把 gateway 当作**无头（headless）推理后端**
5. **Agent 定义**：`agentDefinitions.js` 中 `hermesAgentDefinition = { id: 'hermes-manager', runtime: 'hermes', ... }`

---

## 3. Control 与 Hermes 交互协议

### 3.1 启动管理

**核心函数**：`startHermesRuntime()`（`controlServerCore.js:1185`）

```javascript
const child = spawn(pythonPath, [HERMES_GATEWAY_SCRIPT, 'run'], {
  cwd: HERMES_ROOT,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: customEnv
})
```

启动后调用 `waitForHermesApiReady()` 轮询 Gateway 健康状态（`http://127.0.0.1:8742/v1/chat/completions` 可用性）。

**健康检查与崩溃恢复**：
- 每 30s 检查 Hermes PID 是否存活
- 若 PID 丢失但状态为 running，调用 `recoverHermesChatRuntime('health_check_pid_missing')`
- 先 `stopHermesRuntime()`（SIGTERM → SIGKILL），再 `startHermesRuntime()`
- 最多 5 次重启，退避间隔 `[0, 2000, 5000, 10000, 30000]` ms

### 3.2 Chat 路径

**消息组装**：`buildHermesChatMessages()`（`controlServerCore.js`）

```javascript
function buildHermesChatMessages(history, userPrompt, binding, options = {}) {
  const messages = [
    { role: 'system', content: buildHermesRuntimeSystemMessage(binding) },
    { role: 'system', content: buildProjectMemorySystemMessage(binding, userPrompt, options).message }
  ]
  const replayableMessages = collectReplayableHermesMessages(history, { limit: replayWindowMessages, userPrompt })
  messages.push(...replayableMessages)
  messages.push({ role: 'user', content: userPrompt })
  return { messages, projectMemory, replayedMessageCount: replayableMessages.length }
}
```

**请求发送**：`requestHermesChatCompletion()`（`modelTaskQueue.js`）

```javascript
const targetUrl = directRoute
  ? `${directRoute.baseUrl}/chat/completions`
  : `${HERMES_API_SERVER_BASE_URL}/chat/completions`  // http://127.0.0.1:8742/v1/chat/completions
```

**完整流程**：
1. `control-console` 发送用户消息
2. `control-server` 调用 `buildHermesChatMessages()` 组装 prompt
3. 通过 `requestHermesChatCompletion()` 将请求加入 `modelTaskQueue`
4. 队列消费后向 Hermes API Server（`127.0.0.1:8742`）发送 POST
5. Hermes Gateway 根据环境变量 `HERMES_MODEL` / `HERMES_PROVIDER` 路由到实际 LLM
6. LLM 返回结果 → Hermes → `control-server` → `control-console`

### 3.3 Reasoning 路径

Reasoning 是可观测执行路径，与普通 Chat 语义分离。

#### 阶段一：Session 创建
`POST /api/control/agents/:agentId/reasoning-sessions` → `createRuntimeSession()`

创建前检查（`buildReasoningStartBlocker()`）：
- 左脑配置已保存
- 模型已加载（provider/baseUrl/model 匹配）
- 配置校验通过
- 预检（preflight）已完成

`createReasoningSession()`：
- 生成 `sessionId`，写入 `state/agent-runtime-sessions/${sessionId}.json`
- 状态初始化为 `planning`
- 调用 `runReasoningSession(sessionId, binding, history)`

#### 阶段二：Plan 生成
`prepareReasoningSessionPlan()` → `runManagedReasoningTask()` → `generateReasoningPlan()`

1. **请求分类**：`resolveReasoningRequestDecision()` 通过规则/启发式判断请求类型
2. **确定性短路**：已知类型且允许确定性计划时，直接返回 fallback plan，**不调用模型**
3. **模型规划**：组装 `buildReasoningPlannerMessages()`，调用 `requestHermesChatCompletion()` 让模型输出 JSON Plan
4. **Plan 规范化**：`normalizeReasoningPlan()` 验证 action 合法性、注入 `skipReview`

Plan 结构：
```json
{
  "planId": "...",
  "goal": "...",
  "strategy": "sequential",
  "steps": [
    { "stepId": "...", "title": "...", "action": "list_directory_contents", "tool": "workspace.listDirectory", "params": {}, "skipReview": true, "dependsOn": [] }
  ]
}
```

#### 阶段三：Step 执行
`runAllReasoningStepsFrom()` 顺序执行 steps：

- 每个 step 调用 `executeReasoningStep()`
- 根据 `step.action` 走不同分支：
  - **确定性操作**：本地执行，结果写入 `session.artifacts`
  - **模型辅助操作**：调用模型生成内容，**不落盘**，进入审核
  - **Story Workflow / GameStudio Bootstrap**：委托给 `executeStoryWorkflowStep()` / `executeGameStudioBootstrapStep()`
  - **最终回答**：调用 `generateReasoningFinalAnswer()`

#### 阶段四：Review 门禁
执行过程中随时可能触发 review（`requestReasoningReview()`）：
- Plan 生成后（manual review 模式）
- Write/Invoke 步骤执行前/后
- 最终答案生成后

用户决策：`POST /api/control/agents/:agentId/reasoning-sessions/:sessionId/review`
- `approve` → 若 `requiresApplyOnApply` 为 true，执行实际落盘，继续下一步
- `back` → 回退到上一步重新执行
- `reject` → 标记失败或从当前步骤重新规划

#### 阶段五：Quality Gate
`finalizeReasoningSessionWithQualityGate()`：
1. **自动评分**：模型对答案评分（0-100），阈值 `HERMES_REASONING_MIN_ACCEPT_SCORE = 80`
2. **自我审查**：模型自审（`verdict: approve | repair | human_review`）
3. `productionTest=true` 时**跳过** quality gate
4. 若未通过 → 进入 `quality_override` review

### 3.4 Control Server 如何组装 Prompt

Prompt 组装分为三层：

#### 第一层：Runtime System Message
`buildHermesRuntimeSystemMessage(binding)`：
```
You are Hermes chat running inside GameStudio control.
Current provider: omlx
Current model: qwen3.5-9b-mlx-4bit
Current base URL: http://127.0.0.1:18888/v1
```

#### 第二层：Project Memory System Message
`buildProjectMemorySystemMessage(binding, userPrompt, options)` 动态加载以下 markdown：

| 记忆文件 | 字符上限 | 说明 |
|---------|---------|------|
| Agent Definition | 2200 | `ai/AGENTS.md` |
| User Preferences | 1200 | `ai/USER.md` |
| Project Memory | 1200 | `ai/MEMORY.md` |
| Long Tasks | 2200 | `ai/memory/LONG_TASKS.md` |
| Project Status | 2400 | `ai/memory/STATUS.md` |
| Task Queue | 2400 | `ai/memory/TASK_QUEUE.md` |
| Decisions | 1800 | `ai/memory/DECISIONS.md` |
| Latest Daily Log | 1800 | `ai/chat/YYYY-MM-DD.md` |
| Skill | 2200 | `.claude/skills/.../SKILL.md` |

支持 **选择性加载**：根据 `userPrompt` 关键词自动筛选，或根据 `selectedSourceIds` 手动指定。

#### 第三层：历史重放 + 当前问题
`collectReplayableHermesMessages()` 从历史对话中提取最近 N 条。

**Reasoning Planner 的特殊指令**：
- 要求返回严格 JSON
- 列出 `Allowed actions` 及各 action 参数规范
- `skipReview` 规则（纯读操作可自动，写操作不可）

**Reasoning Answer 的特殊指令**：
- 基于 **observable artifacts** 回答（directory listings, file contents, story production results 等）
- 禁止编造未执行的工具、文件、API
- 禁止说"让我继续读取"等拖延语
- 中文输出要求

### 3.5 Action Registry 和 Tool Registry

**两者都是 Control 侧的注册表，不是 Hermes 侧的。**

**Tool Registry**（`capabilities/toolRegistry.js`）定义 `REASONING_TOOLS`：
```javascript
'workspace.listDirectory': {
  tool: 'workspace.listDirectory',
  executionMode: 'deterministic',  // 本地确定性执行
  reviewPolicy: 'auto',            // 无需人工审核
  routes: ['internal:reasoning/workspace.listDirectory']
}
```

**Action Registry**（`capabilities/actionRegistry.js`）定义 `REASONING_ACTIONS`：
```javascript
edit_workspace_file: {
  title: '编辑工作区文件',
  tool: REASONING_TOOLS['workspace.editFile'].tool,
  category: 'write',
  description: '...',
  paramsSpec: ['filePath: ...', 'content: ...']
}
```

**关系**：
- **Action** 是语义层。Planner（模型）输出的是 `action` 名（如 `edit_workspace_file`）。
- **Tool** 是执行层。`executeReasoningStep()` 通过 action 找到对应 tool，再根据 `executionMode` 决定本地执行或调用模型。
- Tool 的 `routes` 全部是 `internal:` 前缀，说明执行完全在 Control Server 内部完成。

**Hermes 只负责**：
1. 生成 Plan（JSON）
2. 生成最终 Answer
3. 生成需要模型辅助的 rewrite 内容

**Control 负责**：
1. 解析 Plan
2. 本地决策执行哪个 action
3. 执行 tool（调用 GameStudio Server API 或文件操作）
4. 把 tool 结果写回 `session.artifacts`

### 3.6 modelTaskQueue 并发管理

**核心参数**：
- `MAX_CONCURRENT_MODEL_TASKS = 1`（默认串行执行）
- `MAX_MODEL_CALLS_PER_SESSION = 16`
- `MODEL_TASK_QUEUE_WAIT_TIMEOUT_MS = 120000`

**调度流程**：
```javascript
while (activeCount < MAX_CONCURRENT_MODEL_TASKS && queue.length > 0) {
  const task = queue.shift()
  activeCount += 1
  task.run()
    .then(task.resolve, task.reject)
    .finally(() => { activeCount -= 1; scheduleNext() })
}
```

**状态回调**：`queued` → `started` → `finished`

### 3.7 多层超时体系

| 超时类型 | 时长 | 代码位置 |
|---------|------|---------|
| Chat 请求超时 | 500,000ms（500s） | `constants.js:7` |
| Quality Gate 请求超时 | 120,000ms（120s） | `constants.js:16` |
| Reasoning Task 硬超时 | 1,500,000ms（25min） | `constants.js:9` |
| Reasoning Task 租约 | 120,000ms（2min） | `constants.js:8` |
| 队列等待超时 | 120,000ms（120s） | `modelTaskQueue.js:8` |

**Reasoning Task 租约机制**：
- 模型调用包装在 `AbortController` 中
- 每 120s probe provider 状态
- 若 provider 正常，**续租**（最多约 12 次）
- 若超过硬超时（25min），强制 abort

**HTTP Fetch 重试**：
- 最多 3 次，指数退避（2s, 4s, 8s）
- 仅对 503/504/429/408/502 重试

### 3.8 Gateway 日志故障检测

`pollHermesGatewayLog()` 每 1.5s 扫描 `/tmp/gamestudio-hermes-gateway.log`：

检测的故障模式：
- `'NoneType' object has no attribute 'config'`
- `Max retries (\d+) exhausted`
- `API failed after \d+ retries`

一旦发现，立即将所有活跃 reasoning session 标记为失败。

### 3.9 Orphan Session 清理

服务器启动时 `cleanupOrphanedReasoningSessions()` 扫描 `state/reasoning-sessions/` 和 `state/agent-runtime-sessions/`，将上次崩溃遗留的 `planning` / `running` session 标记为 `failed`。

---

## 4. Hermes 自治边界

### 4.1 Hermes 自己能做什么（自治部分）

| 能力 | 说明 |
|------|------|
| **对话循环自治** | 自主决定何时调用 tool、何时返回最终答案 |
| **工具调用自治** | 自主选择和调用 tools（通过 registry），包括 execute_code、browser、web_search 等 |
| **上下文压缩自治** | token 超标时自主决定压缩策略 |
| **记忆读写自治** | 通过 `memory_tool` 自主读写 MEMORY.md / USER.md |
| **技能发现自治** | 自主发现和调用 skills |
| **会话搜索自治** | 通过 `session_search` 自主检索历史会话 |
| **子代理调度自治** | 通过 `delegate_task` 自主 spawn 子代理 |
| **错误恢复自治** | 模型响应无效时自主 retry / fallback |

### 4.2 Control 侧做了什么（受控部分）

| 能力 | 说明 |
|------|------|
| **生命周期管理** | 启动、停止、健康检查、崩溃恢复、PID 管理 |
| **配置管理** | 保存、读取、校验 provider/baseUrl/model 配置 |
| **模型加载管理** | 直接操作 OMLX provider 加载/卸载模型 |
| **Prompt 组装** | 构建 system message、注入记忆文件、历史重放 |
| **Plan 解析与执行** | 解析 Hermes 生成的 JSON Plan，本地执行 steps |
| **Tool 执行（Story）** | 调用 GameStudio Server API 完成 story workflow |
| **审核门禁** | Plan review、Step review、Quality Gate、Human Review |
| **会话状态管理** | Session 创建、轮询、取消、review、落盘 |
| **Gateway 日志监控** | 实时检测 OMLX 故障并标记 session 失败 |

### 4.3 自治 vs 受控的边界

```
┌─────────────────────────────────────────────────────────────┐
│                    Control Server (Node/Hono)               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ 生命周期管理 │  │ Prompt 组装  │  │ Plan 解析 & Step 执行│ │
│  │ 配置/模型管理│  │ 记忆注入     │  │ Review Gate         │ │
│  │ 日志监控     │  │ 历史重放     │  │ GameStudio API 调用  │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                         │                                   │
│              HTTP POST /v1/chat/completions                │
│                         │                                   │
│              ┌──────────┴──────────┐                      │
│              │  Hermes Gateway      │                      │
│              │  (Python, :8742)     │                      │
│              └──────────┬──────────┘                      │
│                         │                                   │
│  ┌──────────────────────┼──────────────────────┐           │
│  │    Hermes 自治区      │                      │           │
│  │  ┌──────────────┐    │    ┌──────────────┐  │           │
│  │  │ AIAgent      │◄───┼───►│  Tool Loop   │  │           │
│  │  │ - 对话循环    │    │    │ - 工具选择    │  │           │
│  │  │ - 上下文压缩  │    │    │ - 工具执行    │  │           │
│  │  │ - 记忆读写    │    │    │ - 并发调度    │  │           │
│  │  │ - 技能调用    │    │    │ - 错误恢复    │  │           │
│  │  └──────────────┘    │    └──────────────┘  │           │
│  └──────────────────────┴──────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

**关键边界**：
- Hermes **不知道** GameStudio Server 的存在，它只知道 OpenAI-compatible API 和 tools
- Control Server **替 Hermes 完成了**所有与 GameStudio Server 的 API 调用
- Hermes 生成的 Plan 中的 action（如 `story_create_project`）被 Control Server 拦截并翻译为具体的 GameStudio Server HTTP 调用
- Hermes **不直接读写** `storage/projects/`，它通过 tool call 间接操作（实际由 Control 执行）

---

## 5. GameStudio 故事生产工作流

### 5.1 P0 文本闭环（已达标）

适合指令："完整/闭环/端到端/一口气/全链路/生产/P0/导出/从创建到导出"

| # | Step | Action | Tool | 执行模式 | 审核 |
|---|------|--------|------|---------|------|
| 1 | 创建互动故事项目 | `story_create_project` | `gamestudio.story.createProject` | deterministic | required |
| 2 | 写入故事生成配置 | `story_configure_project` | `gamestudio.story.configureProject` | deterministic | required |
| 3 | 生成故事脚本候选 | `story_generate_scripts_candidate` | `gamestudio.story.generateScriptsCandidate` | model-assisted | auto |
| 4 | 写入故事脚本 | `story_write_scripts` | `gamestudio.story.writeScripts` | deterministic | required |
| 5 | 生成 Story Bible | `story_create_bible` | `gamestudio.story.createBible` | model-assisted | required |
| 6 | 编译脚本为蓝图 | `story_compile_blueprint` | `gamestudio.story.compileBlueprint` | deterministic | required |
| 7 | 智能体评审蓝图 | `story_review_blueprint_agent` | `gamestudio.story.reviewBlueprintAgent` | model-assisted | auto |
| 8 | 按评审修复蓝图 | `story_repair_blueprint_if_needed` | `gamestudio.story.repairBlueprintIfNeeded` | model-assisted | required |
| 9 | 图片前置检查 | `story_preflight_image_provider` | `gamestudio.story.preflightImageProvider` | deterministic | auto |
| 10 | 编译蓝图为可运行故事 | `story_compile_compose` | `gamestudio.story.compileCompose` | deterministic | required |
| 11 | 校验互动故事项目 | `story_validate_project` | `gamestudio.story.validateProject` | deterministic | auto |
| 12 | 导出互动故事项目 | `story_export_project` | `gamestudio.story.exportProject` | deterministic | required |
| 13 | 生成最终回答 | `generate_default_answer` | `model.answer` | model-assisted | auto |

### 5.2 P1 图片资产闭环（进行中，未达标）

适合指令："资产/背景图/角色/立绘/出图/锁定事物"

| # | Step | Action | 状态 |
|---|------|--------|------|
| 1 | 生成 Story Bible | `story_create_bible` | ✅ |
| 2 | 创建资产计划 | `story_create_asset_plan` | ✅ |
| 3 | 图片 Provider 前置检查 | `story_preflight_image_provider` | ✅（basic），storyboard 待验证 |
| 4 | 绘制锁定事物参考图 | `story_generate_lock_asset_references` | ❌ character 阻塞 |
| 5 | 场景渲染（批量） | `story_render_scene` / `story_batch_render_scenes` | ❌ 未实现 |
| 6 | 场景资源回填 | `story_backfill_scene_assets` | ❌ 未实现 |
| 7 | 校验资产引用 | `story_validate_project` | ✅ |
| 8 | 导出带资产项目 | `story_export_project` | ✅ |

### 5.3 核心 API 清单

Control Server 通过 `gameStudioServerClient.js` 调用 GameStudio Server（`http://127.0.0.1:1999`）：

| Action | API | Method | Path |
|--------|-----|--------|------|
| `story_create_project` | `createProject` | POST | `/api/projects` |
| `story_create_ai_project` | `createAiProject` | POST | `/api/projects/ai/create` |
| `story_configure_project` | `updateProject` | PUT | `/api/projects/:id` |
| `story_inspect_project` | `getProject`+`getScripts`+`listExports` | GET | `/api/projects/:id` 等 |
| `story_generate_scripts_candidate` | 内部 reasoning（调用 Hermes/OMLX） | — | `internal:hermes/story.scripts.candidate` |
| `story_write_scripts` | `putScripts` | PUT | `/api/projects/:id/scripts` |
| `story_compile_blueprint` | `compileBlueprint` | POST | `/api/projects/:id/compile/blueprint` |
| `story_analyze_scripts` | `analyzeScripts` | POST | `/api/projects/:id/analyze/scripts` |
| `story_review_blueprint_agent` | `validateBlueprint`+`reviewBlueprint` | POST | `/api/projects/:id/validate/blueprint` + `/api/projects/:id/ai/review/blueprint` |
| `story_repair_blueprint_if_needed` | `fixScripts`+`compileBlueprint` | POST | `/api/projects/:id/ai/fix/scripts` + `/api/projects/:id/compile/blueprint` |
| `story_compile_compose` | `compileCompose` | POST | `/api/projects/:id/compile/compose` |
| `story_validate_project` | `validateBlueprint` | POST | `/api/projects/:id/validate/blueprint` |
| `story_export_project` | `exportProject` | POST | `/api/projects/:id/export` |
| `story_create_bible` | `createStoryBible` | POST | `/api/projects/:id/ai/story/bible` |
| `story_create_asset_plan` | `createStoryAssetPlan` | POST | `/api/projects/:id/ai/story/assets/plan` |
| `story_generate_lock_asset_references` | `generateStoryAssetReference`+`selectStoryAssetReference` | POST | `/api/projects/:id/ai/story/assets/reference` + `/ai/story/assets/reference/select` |
| `story_lock_test` | `storyLockTest` | POST | `/api/projects/:id/ai/story/lock/test` |
| `story_generate_asset_candidate` | `generateBackground` | POST | `/api/projects/:id/ai/background` |
| `story_preflight_image_provider` | `preflightImageProvider` | POST | `/api/studio/image/preflight` |

### 5.4 审核策略

```
isReasoningStoryMutationAction(action) → true 的 action：
  story_create_project, story_create_ai_project, story_configure_project,
  story_write_scripts, story_compile_blueprint, story_repair_blueprint_if_needed,
  story_compile_compose, story_create_bible, story_create_asset_plan,
  story_generate_lock_asset_references, story_lock_test,
  story_generate_asset_candidate, story_export_project

isReasoningWriteAction(action) → 包含上述 + 文件编辑操作
```

**默认策略**：所有 `story_*` mutation action 的 `reviewPolicy = 'required'`（需人工审核），`skipReview = false`。

**例外**：`productionTest=true` 时 bypass 所有 review gate（设计意图）。

### 5.5 项目文件结构

每个项目在 `storage/projects/{projectId}/` 下：

```
project.json      # 项目元数据、characters、assets、state
story.json        # 合成层：nodes、choices、timeline、visuals
meta.json         # 生成公式、时间戳
scripts.json      # 脚本层：cards（text、options）
blueprint.json    # 蓝图层：nodes、placeholders、choices、startNodeId
story-assets/
  plan.json       # 资产计划
assets/
  ai/             # AI 生成的背景图和参考图
  uploads/        # 用户上传资源
builds/
  latest/
    dist/
      index.html  # 导出产物
```

---

## 6. 补齐清单：让 Hermes 完全自治

> 以下清单基于 `docs/PRODUCTION_DEFECTS.md`、`ai/memory/LONG_TASKS.md`、代码事实分析得出。
> P0 = 文本闭环（已达标，需巩固）；P1 = 图片资产闭环（未达标，当前最大阻塞）；S3 = 生产运维闭环（待启动）。

### 6.1 阶段 A：巩固 P0（高优先级）

| # | 任务 | 根因/现状 | 具体行动 | 预期产出 | 状态 |
|---|------|----------|----------|---------|------|
| A1 | 修复 evaluator false-pass | `finalizeReasoningSessionWithQualityGate` 中 evaluator 返回 FAIL 时仍判 PASS | 收紧逻辑：evaluator FAIL → 强制 `passed=false`，`productionTest` 模式也不应 false-pass | `L4-04` 测试严格通过 | ⏳ 待执行 |
| A2 | 修复模型切换回滚留空 | unload 成功但 rollback load 失败时 OMLX 无模型 | unload/load 失败时自动加载最小可用模型并标记降级状态 | 模型切换稳定性 | ⏳ 待执行 |
| A3 | 修复模型名大小写敏感 | catalog 查找大小写敏感导致 metadata 缺失 | 统一使用小写模型名 | catalog 查找稳定 | ⏳ 待执行 |
| A4 | 修复内存泄漏 | `sessionCallCounts`/`inspectModelAccessCache` 无清理 | session 完成时清理计数器和缓存 | 长期运行稳定性 | ⏳ 待执行 |
| A5 | 修复 Port 清理不可靠 | `restart_control.sh` 偶发 port 占用 | 增强 restart 脚本 port 检测与清理 | 重启可靠性 | ⏳ 待执行 |
| A6 | 补全安全基线 | Control API 完全无认证；OMLX API key 硬编码 `'omlx123'` | 添加 `X-API-Key` 中间件；移除硬编码 fallback | 最小安全边界 | ⏳ 待执行 |

### 6.2 阶段 B：打通 P1 图片资产闭环（当前最大阻塞）

| # | 任务 | 根因/现状 | 具体行动 | 预期产出 |
|---|------|----------|----------|---------|
| B1 | 集成/启动 ComfyUI | `image_provider_not_ready`，ComfyUI 未集成/未运行 | 安装 ComfyUI，确认 `system_stats` 可达，必要节点（IP-Adapter、Load Image）存在 | 图片 provider 就绪 |
| B2 | 实现 Character asset pipeline | `assetKind === 'character'` 直接返回失败 | 在 `apps/server/src/ai/storyAssets.js` 中实现 character 生成路径 | P0-02 关闭 |
| B3 | 验证场景渲染完整链路 | `POST /api/projects/:id/ai/story/scenes/:sceneId/render` 未验证 | 验证含 IP-Adapter referenceImages 的完整链路 | 场景渲染可用 |
| B4 | 实现场景资源回填闭环 | 场景图生成后 `project.json` 引用更新未闭环 | 渲染后自动更新 `project.json` visuals.background → validate → re-export | 资源回填可用 |
| B5 | 实现批量场景渲染队列 | 无批量/连续分镜队列 | 添加 `story_batch_render_scenes` action/tool，按 story 顺序批量生成 | 批量渲染可用 |
| B6 | 实现锁定评审视觉模型 fallback | `reviewStoryboardLockImageWithAi` 需要视觉模型，本地 OMLX 可能不支持 | 若 OMLX 不支持 vision，fallback 到 OpenAI API 或人工审核标记 | 锁定评审可用 |
| B7 | 注册新工具到 Registry | `toolRegistry.js` + `actionRegistry.js` 缺少 render/backfill/batch 工具 | 注册 `story_render_scene`、`story_backfill_scene_assets`、`story_batch_render_scenes` | 工具链完整 |
| B8 | 添加 P1 asset closure skill | 当前唯一 skill `gamestudio-workspace` 缺少 asset 链路 hint | 新建 `config/hermes/skills/story-p1-asset-closure/SKILL.md` | Hermes 知道如何执行 P1 |
| B9 | 添加 P1 相关 JSON intents | 无 `gamestudio.p1_asset_evidence`、`gamestudio.scene_render_evidence` | 在 `intents/` 中注册新 intent | P1 答案质量门 |

### 6.3 阶段 C：建立 S3 生产运维闭环（中长期）

| # | 任务 | 具体行动 | 预期产出 |
|---|------|----------|---------|
| C1 | 实现任务状态机 | 定义 session 生命周期：queued → running → pausing → paused → resuming → completed/failed/cancelled | U-01 关闭 |
| C2 | 实现跨重启 checkpoint | 定期持久化 session 状态；重启后扫描 orphan session 并收敛 | U-02 关闭 |
| C3 | 实现批量任务队列 | 支持 per-project workflow 的批量调度、暂停、取消、续跑 | U-03 关闭 |
| C4 | 实现 `_inbox` 自动化测试晋级 | proposal 必须经自动化测试、可视化审批后才可晋级 | U-04/U-08 关闭 |
| C5 | 生产运维 UI | Control Console 增加"取消当前 session"、"停止 production test"、"恢复异常任务"按钮 | U-06 关闭 |
| C6 | Hermes Gateway 崩溃自动重启 | 注册 `child.on('exit')` 自动重启逻辑（当前 Control 只监控 PID，不自动重启 gateway 进程本身） | U-09 关闭 |
| C7 | 动态模型切换 UI | Control Console 增加 `workflow.modelRouting` 配置面板 | U-07 关闭 |

### 6.4 阶段 D：质量与契约补齐

| # | 任务 | 具体行动 |
|---|------|----------|
| D1 | 更新 `gamestudio-workspace/SKILL.md` | 增加 `story_render_scene`、`story_backfill_scene_assets`、`story_batch_render_scenes` 的 planner hints |
| D2 | 更新 `PRODUCTION_DEFECTS.md` | 修复后归档到"已修复归档"区 |
| D3 | 更新 `LONG_TASKS.md` | P1 达标后标记为 ✅，启动 S3 |
| D4 | 更新 `DECISIONS.md` | 若有新的稳定规则（如 P1 必须先锁定再渲染）写入 |
| D5 | 回归测试 | 执行 `bash scripts/test/smoke_test_pipeline.sh` 和 `npm run test:control-production` |

### 6.5 关键阻塞点总结

| 阻塞点 | 严重程度 | 影响 |
|--------|---------|------|
| ComfyUI 未集成/未运行 | 🔴 阻断 | P1 图片资产闭环完全无法启动 |
| Character asset pipeline 未实现 | 🔴 阻断 | 角色立绘无法生成 |
| Evaluator false-pass | 🟡 高 | 质量门禁不严，缺陷产物流出 |
| 场景渲染 → 回填闭环未验证 | 🟡 高 | 即使渲染成功也无法自动更新项目 |
| Control API 无认证 | 🟠 中 | 安全风险 |
| 批量渲染队列未实现 | 🟠 中 | 无法高效处理多场景故事 |

---

## 附录 A：核心调用链速查

### Control Server

| 功能 | 入口函数 | 文件 |
|------|---------|------|
| 启动 Hermes | `startHermesRuntime()` | `controlServerCore.js:1185` |
| 停止 Hermes | `stopHermesRuntime()` | `controlServerCore.js:1287` |
| 获取运行时状态 | `getHermesRuntimeState()` | `controlServerCore.js:1034` |
| 组装 Chat Prompt | `buildHermesChatMessages()` | `controlServerCore.js:~9799` |
| 组装 Runtime System Msg | `buildHermesRuntimeSystemMessage()` | `controlServerCore.js:9493` |
| 组装 Project Memory Msg | `buildProjectMemorySystemMessage()` | `controlServerCore.js:9736` |
| 创建 Reasoning Session | `createReasoningSession()` | `controlServerCore.js:9077` |
| 执行 Reasoning Step | `executeReasoningStep()` | `controlServerCore.js:8040` |
| 执行 Story Workflow Step | `executeStoryWorkflowStep()` | `controlServerCore.js` |
| 生成 Reasoning Plan | `generateReasoningPlan()` | `modelRequests.js:353` |
| 质量门 | `finalizeReasoningSessionWithQualityGate()` | `qualityGate.js:581` |
| 模型任务队列 | `enqueueModelTask()` / `scheduleNext()` | `modelTaskQueue.js` |
| 网关日志监控 | `pollHermesGatewayLog()` | `controlServerCore.js:313` |
| 健康检查 | `ensureHermesHealthCheck()` | `controlServerCore.js:386` |

### Hermes Gateway / Agent

| 功能 | 入口函数 | 文件 |
|------|---------|------|
| Gateway 启动 | `start_gateway()` | `gateway/run.py` |
| Runner 生命周期 | `GatewayRunner.start()` / `.stop()` | `gateway/run.py` |
| 消息入口 | `_handle_message(event)` | `gateway/run.py` |
| Agent 执行 | `_run_agent()` → `agent.run_conversation()` | `gateway/run.py` → `run_agent.py` |
| 对话循环 | `run_conversation()` | `run_agent.py` |
| System Prompt 构建 | `_build_system_prompt()` | `run_agent.py` |
| Tool Loop | `while api_call_count < max_iterations` | `run_agent.py` |
| Tool 执行 | `_execute_tool_calls()` → `_invoke_tool()` | `run_agent.py` |
| 工具注册/发现 | `discover_builtin_tools()` / `register()` | `model_tools.py` / `tools/registry.py` |
| 内置记忆加载 | `MemoryStore.load_from_disk()` | `tools/memory_tool.py` |
| 外部记忆召回 | `MemoryManager.prefetch_all()` | `agent/memory_manager.py` |

---

## 附录 B：术语表

| 术语 | 说明 |
|------|------|
| **Hermes** | Nous Research 开源的 Python AI Agent 框架 |
| **Gateway** | Hermes 的常驻消息网关进程，支持多平台接入 |
| **AIAgent** | Hermes 的核心对话代理类，管理 tool calling loop |
| **Control Server** | GameStudio 控制平面后端（Hono/Node），管理 Hermes 生命周期和配置 |
| **Control Console** | GameStudio 控制平面前端（Vue），操作界面 |
| **OMLX** | 本地模型服务（OpenML X），`http://127.0.0.1:18888/v1` |
| **Reasoning Session** | 可观测执行路径，含 plan → step → review → quality gate |
| **Review Gate** | 审核门禁，关键操作需人工确认后才执行 |
| **Quality Gate** | 质量门禁，模型自动评分 + 自审，未通过需人工 override |
| **Tool Registry** | Control 侧的工具元数据注册表（非 Hermes 侧） |
| **Action Registry** | Control 侧的 action 语义注册表（非 Hermes 侧） |
| **Story Bible** | 故事圣经，含角色、道具、地点、场景引用 |
| **Asset Plan** | 资产计划，定义每个资产的类别、锁定配置、渲染策略 |
| **Lock Asset** | 锁定事物，为关键角色/道具/地点生成参考图，保证风格一致性 |
| **Preflight** | 起飞前检查，确认 provider/model/工具就绪 |
| **P0 闭环** | 文本互动故事生产闭环（创建→脚本→蓝图→合成→校验→导出） |
| **P1 闭环** | 图片资产生产闭环（Bible→Plan→锁定→渲染→回填→校验→导出） |

---

*文档版本：基于 2026-05-28 代码事实*
*维护者：AI Agent 编码代理*
*下次更新时机：P1 图片资产闭环达标后*
