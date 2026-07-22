# Hermes 智能体系统能力差距分析与补齐方案

> 本文档回答两个核心问题：
> 1. 要达到"给定任务 → 分析 → 准确完成"的完整自主能力，还缺失哪些功能？
> 2. 此智能体能否达到类似 Kimi / Claude Code / Codex / ChatGPT 的功能？
>
> 状态：基于 2026-05-28 代码事实与公开产品信息编写。

---

## 执行摘要

**直接回答第二个问题**：

> **当前不能**。Hermes / GameStudio Control 是一个**垂直领域（互动故事生产）的半自动控制器**，在通用编码、Web 访问、多模态理解、自主执行等维度上与主流 AI Agent 存在**结构性差距**。但通过系统性补齐（预计 3-6 个月），可以达到**领域增强型 Agent** 水平——在故事生产领域超越通用 Agent，在通用编码任务上接近主流水平。

**关键差距维度**（按严重程度排序）：

| 排名 | 差距维度 | 严重程度 | 补齐难度 |
|------|---------|---------|---------|
| 1 | 无浏览器/Web 搜索能力 | 🔴 阻断通用任务 | 中 |
| 2 | 无原生多模态（图片理解/VLM） | 🔴 阻断视觉任务 | 中 |
| 3 | 无 MCP / 开放工具生态 | 🔴 阻断扩展性 | 低 |
| 4 | 无任意 Shell / 测试运行 / Git | 🟡 高 | 低-中 |
| 5 | 审批机制过粗（binary 而非分级） | 🟡 高 | 中 |
| 6 | 无子 Agent / 并行执行 | 🟡 高 | 高 |
| 7 | 记忆机制原始（文件级 markdown） | 🟠 中 | 中 |
| 8 | 无动态规划 / 递归 replanning | 🟠 中 | 高 |
| 9 | 无代码索引 / AST / 语义搜索 | 🟠 中 | 中 |
| 10 | 上下文压缩缺失 | 🟠 中 | 低 |

---

## 1. 当前 Hermes / Control 的完整能力清单

### 1.1 Hermes 原生工具集（Python Agent 框架层）

| 工具类别 | 工具名 | 功能 | 审批 |
|---------|--------|------|------|
| **终端** | `terminal` | 执行任意 shell 命令（本地/Docker/Modal/Daytona/Vercel/SSH） | 需审批（dangerous patterns） |
| **代码执行** | `execute_code` | 执行 Python 脚本（支持工具调用内嵌） | 需审批 |
| **文件** | `read_file` | 读取文件（支持偏移/行数限制） | 自动 |
| **文件** | `write_file` | 覆盖写入文件 | 需审批 |
| **文件** | `patch` | 模糊匹配替换或 V4A 多文件补丁 | 需审批 |
| **文件** | `search_files` | ripgrep 内容搜索或 glob 文件名搜索 | 自动 |
| **Web** | `web_search` | Web 搜索（支持高级运算符） | 自动（需 API Key） |
| **Web** | `web_extract` | 网页/PDF 提取为 Markdown | 自动（需 API Key） |
| **浏览器** | `browser_navigate` | 浏览器导航 | 自动（需配置） |
| **浏览器** | `browser_snapshot` | 获取页面可访问性树 | 自动 |
| **浏览器** | `browser_click/type/scroll/back/press` | 浏览器交互 | 自动 |
| **浏览器** | `browser_vision` | 页面截图后视觉问答 | 自动 |
| **浏览器** | `browser_console` | 执行 JS 表达式 | 自动 |
| **浏览器** | `browser_cdp` | Chrome DevTools Protocol 原始调用 | 自动 |
| **视觉** | `vision_analyze` | 图片理解/分析（URL 或本地路径） | 自动 |
| **视觉** | `video_analyze` | 视频理解/分析 | 自动 |
| **图片生成** | `image_generate` | 文生图 | 自动 |
| **语音** | `text_to_speech` | 文本转语音 | 自动 |
| **技能** | `skills_list/view/manage` | Skill 发现、查看、管理 | 自动 |
| **任务** | `todo` | 任务列表管理 | 自动 |
| **记忆** | `memory` | 记忆增删改查 | 自动 |
| **会话** | `session_search` | 历史会话搜索 | 自动 |
| **委派** | `delegate_task` | 子代理委派 | 自动 |
| **消息** | `send_message` | 多平台消息发送 | 自动 |
| **Discord** | `discord/discord_admin` | Discord 操作 | 自动（需 Token） |
| **Home Assistant** | `ha_list_entities/get_state/call_service` | 智能家居控制 | 自动 |
| **飞书** | `feishu_doc_read/drive_*` | 飞书文档/评论 | 自动 |
| **元宝** | `yuanbao_send_text/image/file/fetch_history` | 元宝消息 | 自动 |
| **RL** | `rl_list_environments/start_training/get_results` | 强化学习训练 | 自动 |
| **看板** | `kanban_show/complete/block/heartbeat/comment/create/link` | 看板任务管理 | 自动 |
| **MCP** | `mcp_*` | 外部 MCP 服务器动态工具 | 自动 |
| **澄清** | `clarify` | 向用户发起确认提问 | 自动 |
| **定时任务** | `cronjob` | Cron 任务管理 | 自动 |
| **MoA** | `mixture_of_agents` | 多模型协作推理 | 自动（需 OpenRouter） |
| **进程** | `process` | 后台进程管理 | 自动 |

**重要说明**：上述工具是 **Hermes 框架原生能力**。但在 GameStudio 的集成中，Control Server **并未暴露**这些通用工具给 reasoning pipeline。Control 侧的 tool registry 只有 26 个工具，全部是 GameStudio 域内工具（见 1.2）。

### 1.2 Control 侧工具集（GameStudio 域内）

| 类别 | Tool | Action | 执行模式 | 审核 |
|------|------|--------|---------|------|
| Context | `context.recent` | — | 自动 | auto |
| Workspace | `workspace.listDirectory` | `list_directory_contents` | 确定性 | auto |
| Workspace | `workspace.readFile` | `read_file_content` | 确定性 | auto |
| Workspace | `workspace.searchText` | `search_workspace_text` | 确定性 | auto |
| Workspace | `workspace.editFile` | `edit_workspace_file` | 模型辅助 | required |
| Workspace | `workspace.createFile` | `create_workspace_file` | 确定性 | required |
| Workspace | `workspace.renamePath` | `rename_workspace_path` | 确定性 | required |
| Workspace | `workspace.deletePath` | `delete_workspace_path` | 确定性 | required |
| Observable | `project.inspectServerImageEntrypoints` | `inspect_image_service_entrypoints` | 确定性 | auto |
| Observable | `project.inspectControlBackendSurfaces` | `inspect_control_backend_surfaces` | 确定性 | auto |
| Memory | `memory.write` | `write_memory_file` | 确定性 | required |
| Memory | `memory.taskQueue` | `update_task_queue` | 确定性 | required |
| Runtime | `runtime.script` | `run_lifecycle_script` | 确定性 | required |
| Runtime | `runtime.workspaceScript` | `run_workspace_script` | 确定性 | required |
| Bootstrap | `gamestudio.bootstrap.*` | `gamestudio_bootstrap_*` | 混合 | auto/required |
| Story | `gamestudio.story.*` (19 个) | `story_*` (19 个) | 混合 | auto/required |
| Planner | `planner.default` | `plan_user_request` | 模型辅助 | auto |
| Answer | `model.answer` | `generate_default_answer` | 模型辅助 | auto |

### 1.3 记忆系统

| 层级 | 载体 | 内容 | 限制 |
|------|------|------|------|
| **短期记忆** | `reasoningSession.artifacts` | 当前 session 的工具结果、listing、文件内容 | session 结束销毁 |
| **对话历史** | `ai/chat/YYYY-MM-DD.json` | Chat 历史重放 | 文件无上限，可能膨胀 |
| **长期记忆** | `ai/memory/*.md` | STATUS、TASK_QUEUE、DECISIONS、LONG_TASKS | 无向量检索、无自动抽取 |
| **Context Pool** | `state/context-pool/` | 用户确认的上下文摘要 | 需手动选择注入 |
| **Skill** | `config/hermes/skills/` | 领域技能定义（目前仅 1 个） | 无自动技能创建 |

### 1.4 审批机制

| 层级 | 机制 | 说明 |
|------|------|------|
| Hardline 黑名单 | 无条件阻止 | `rm -rf /`、`mkfs`、fork bomb 等，不可绕过 |
| Dangerous Patterns | 需审批 | 递归删除、chmod 777、git destructive、SQL DROP 等 |
| Review Gate | 人工审核 | 所有 write/invoke/story_mutation 动作停等 human review |
| Quality Gate | 模型评分 | 自动评分（0-100），低于 80 停等 override |

---

## 2. 与主流 AI Agent 的对比矩阵

| 能力维度 | Hermes/GameStudio Control | Kimi K2.5 / Kimi Code | Claude Code | Codex (OpenAI) | ChatGPT (o3/o4) | Cursor / Copilot | Windsurf / Cline |
|----------|---------------------------|----------------------|-------------|----------------|-----------------|------------------|------------------|
| **核心工具集** | 文件读写/搜索/编辑、白名单脚本、19 个 story 专用工具 | Bash/文件/浏览/提交；Agent Swarm 100 并行；1,500 工具调用 | 54 个工具（Bash/读/写/编辑/Grep/Glob/Web/MCP/Agent）| 读/写/Bash/浏览/浏览器/MCP/Skills；40+ 工具 | 代码解释器/浏览/DALL-E/文件上传/Canvas/Custom Actions | Cursor: Tab/Chat/Composer/Background Agent；Copilot: 补全/Chat/Agent/Workspace | Cascade/Plan-Act/浏览器/MCP/多 Agent |
| **自主执行级别** | Reasoning Session 多步可观测执行；13 步 story workflow 闭环；**非完全自主**，关键操作需审批 | **高**：4 模式从即时到 Agent Swarm；200-300 顺序调用或 100 并行 agent | **高**：终端原生 agent；子 agent 编排；extended thinking | **高**：3 种信任模式；Plan Mode；Cloud 异步 | **中高**：o3/o4 agentic 组合所有工具 | **高**：Composer 自主多文件；Background Agent 云端自主 | **高**：Cascade 10-step planning；Cline Plan/Act 显式控制 |
| **安全/审批机制** | Review Gate：write/invoke 强制人工审核；auto 动作自动执行；production test 可 bypass | 基础审批；Agent 模式主动澄清；无精细权限分级 | **7 种权限模式** + ML 分类器；per-action 评估；Computer Use 额外授权 | **OS 级沙箱**（Seatbelt/seccomp/Windows ACL）；3 种执行模式；显式升级 | 对话级确认；沙箱代码执行；企业安全控制 | Cursor: Inline diff 审批；Privacy Mode。Copilot: 显式审批+企业审计 | Cline: 每步审批+Checkpoint。Windsurf: 透明 plan.md |
| **上下文管理** | 256K (K2)；Chat history；Context Pool；Memory 文件；Reasoning lease/timeout/retry | 256K 上下文；Multi-Head Latent Attention 压缩 | **200K**；5 层压缩管道；Memory Tool；Server-Side Compaction；Context Editing | Context Compaction；AGENTS.md 项目契约；Skills | Memory；Projects；扩展上下文 | Cursor: 全仓库索引；.cursorrules。Copilot: Spaces | Memories；Rules；.clinerules；M-Query 索引 |
| **记忆能力** | 文件级记忆（markdown），无结构化跨会话记忆 | 会话连续性；Agent Swarm 结果聚合 | **Memory Tool**（文件系统持久记忆）；CLAUDE.md 项目记忆 | Memory 命令；持久会话 | **跨会话 Memory**；Projects 记忆 | 项目规则持久化；索引持久化 | 上下文持久化；项目规则 |
| **多模态能力** | ❌ **无原生图片理解**；✅ 图片生成（ComfyUI/SD-WebUI）| ✅ **原生多模态**；图片/视频输入；Vision-to-Code；自主视觉调试 | ✅ 图片理解；Computer Use（屏幕控制）| ✅ 图片输入；Appshots | ✅ **完整多模态**：图片理解+生成(DALL-E)+语音+视频 | ✅ 图片输入理解 | ✅ 基础图片输入 |
| **代码执行环境** | 脚本白名单执行（sh/js）；无沙箱 | 终端工作流；代码解释器 | Bash 终端；Sandbox 代码执行 | **OS 级沙箱**（网络隔离）| Python 沙箱（Code Interpreter）| 内置终端 | Bash 终端 |
| **浏览器能力** | ❌ **无** | ✅ Web Browsing；BrowseComp 74.9% | ✅ WebFetch/WebSearch；WebBrowserTool | ✅ Browser 工具；Chrome Extension | ✅ Web Browsing（Bing）| ✅ Web 搜索 | ✅ Headless Browser（Cline）|
| **Git 集成** | 间接（通过脚本）| 基础 | ✅ 原生深度集成 | ✅ 集成；Worktree Isolation | 无直接集成 | ✅ Copilot 深度集成；Cursor 基础 | ✅ CI/CD 集成（Cline）|
| **MCP 支持** | ❌ **无** | ✅ 支持 | ✅ **深度集成** | ✅ 支持 | 间接（Custom Actions）| ✅ Cursor 支持 | ✅ **深度集成** |
| **模型灵活性** | OMLX 本地模型（Qwen/Gemma/GPT-OSS）；单模型约束 | 自有 K2.5 模型；开源可本地部署 | Claude 模型族（Haiku/Sonnet/Opus）| OpenAI 模型（codex-mini/o3/o4）| OpenAI 自有模型 | 多模型（GPT/Claude/Gemini）| 30+ 提供商（BYOK）|
| **外部系统集成深度** | GameStudio Server API；ComfyUI；OMLX | IDE 插件；API | MCP；外部服务；插件 | MCP；Cloud；Chrome；IDE | Custom GPTs；GPT Store | Datadog MCP；GitHub 生态 | Slack/Linear/CI；数据库/API |

---

## 3. 差距分析：按优先级

### 🔴 P0 — 阻断通用任务（必须先补齐）

#### 3.1 无浏览器 / Web 搜索能力

**现状**：Control 侧完全没有 Web 搜索、URL 抓取、浏览器导航工具。所有 HTTP fetch 仅限内网服务（OMLX、GameStudio Server）。

**影响**：
- 无法获取外部文档、API 文档、最新信息
- 无法验证技术方案（如"ComfyUI 最新版本如何安装"）
- 无法检索 GitHub Issues、Stack Overflow 解决方案
- 无法抓取参考网站作为故事素材

**对比**：Claude Code 有 WebFetch/WebSearch/WebBrowserTool；Codex 有 Browser 工具；Kimi 有 Web Browsing；ChatGPT 有 Bing Browsing。

#### 3.2 无原生多模态（图片理解 / VLM）

**现状**：Hermes 框架原生有 `vision_analyze` 工具，但 GameStudio Control **未集成**。系统只能生成图片（ComfyUI 文生图），**无法理解图片输入**。

**影响**：
- 无法分析 UI 截图、设计稿、参考图
- 无法做视觉调试（"这张截图上的按钮为什么没对齐"）
- 无法审核锁定参考图的质量（只能依赖确定性规则，不能"看懂"图片）
- 无法从视频/图片中提取故事灵感

**对比**：Kimi 支持 Vision-to-Code（从 UI mockup 生成代码）；Claude 支持 Computer Use（屏幕控制）；ChatGPT 支持图片理解+生成+语音+视频。

#### 3.3 无 MCP / 开放工具生态

**现状**：Hermes 框架原生支持 MCP（`mcp_tool.py`），但 GameStudio Control **未启用**。Control 的 tool registry 是封闭列表（26 个固定工具），无法动态扩展。

**影响**：
- 无法连接数据库（PostgreSQL、SQLite）
- 无法连接外部 API（Stripe、AWS、GitHub）
- 无法接入基础设施工具（Docker、Kubernetes、Terraform）
- 无法接入代码质量工具（ESLint、Prettier、SonarQube）

**对比**：Claude Code / Codex / Cline 均深度支持 MCP，生态已有数千个 MCP 服务器。

### 🟡 P1 — 高影响（严重限制自主性）

#### 3.4 无任意 Shell / 测试运行 / Git

**现状**：
- Shell：仅白名单脚本（`restart_control.sh`、`reporter.sh` 等），无任意 `bash` 工具
- 测试：无 `npm test`、`pytest`、`jest` 调用能力
- Git：无 `git status`/`diff`/`commit`/`branch` 工具

**影响**：
- 无法运行类型检查（`tsc`、`npm run typecheck`）
- 无法运行测试并修复失败用例
- 无法自动提交代码、创建分支、发起 PR
- 无法查看 git history 定位问题引入时间

**对比**：所有主流 Coding Agent（Claude Code、Codex、Cursor、Cline）均原生支持 Bash + Git + 测试运行。

#### 3.5 审批机制过粗（Binary 而非分级）

**现状**：审核只有两档：`auto`（自动执行）和 `required`（停等人工）。无中间态（如"自动执行但记录日志"、"低风险自动/高风险人工"）。

**影响**：
- 用户体验两极分化：要么全部手动确认（繁琐），要么 productionTest bypass（过于开放）
- 无法实现"夜间无人值守自动跑 workflow"
- 无法根据操作风险等级动态调整审批策略

**对比**：Claude Code 有 7 种权限模式 + ML 分类器；Codex 有 3 种信任模式（Suggest/Auto-Edit/Full-Auto）。

#### 3.6 无子 Agent / 并行执行

**现状**：Reasoning session 是单线程顺序执行（`strategy: "sequential"`）。无子任务分解器、无并行 step、无子 agent 委托。

**影响**：
- 复杂任务无法分解为并行子任务（如"同时生成 3 个场景的背景图"）
- 长链任务（>20 步）效率低下
- 无法利用多核/GPU 并行加速

**对比**：Kimi Agent Swarm 支持 100 并行 agent；Claude 支持子 agent 编排；Cursor Composer 支持 8 并行 agent。

### 🟠 P2 — 中等影响（限制效率和体验）

#### 3.7 记忆机制原始

**现状**：文件级 markdown 记忆（STATUS.md、TASK_QUEUE.md 等），无向量检索、无自动抽取、无时间衰减。

**影响**：
- 会话间状态丢失，每次新 session 需重新加载记忆文件
- 无法从对话历史中自动抽取事实（如"用户喜欢悬疑风格"）
- 记忆文件膨胀后读取效率下降

**对比**：Claude 有 Memory Tool（文件系统持久记忆）；ChatGPT 有跨会话 Memory；Cursor 有全仓库语义索引。

#### 3.8 无动态规划 / 递归 Replanning

**现状**：Plan 一旦生成即固定执行。步骤失败后不会自动调整计划，只会记录 `failedStage` 并等待人工介入。

**影响**：
- "优化整个项目性能"无法自动分解为子任务
- 步骤失败后无法自我修复（如"编译失败 → 读取错误 → 修改代码 → 重试编译"循环）
- 无法根据中间结果动态调整后续步骤

**对比**：Codex 有 Plan Mode（先规划后执行）；Cline 有 Plan/Act 模式；Claude 支持 Extended Thinking 动态推理。

#### 3.9 无代码索引 / AST / 语义搜索

**现状**：`search_files` 基于 ripgrep 正则搜索，不是语义搜索。无 AST 解析、无符号索引、无类型检查。

**影响**：
- 无法精准定位"这个函数在哪里被调用"
- 无法做跨文件重构（重命名变量并更新所有引用）
- 无法理解代码结构（类继承、模块依赖）

**对比**：Cursor 有全仓库语义索引；Copilot 有代码语义理解；Claude Code 有 GrepTool + GlobTool 组合。

#### 3.10 上下文压缩缺失

**现状**：无自动上下文压缩。长会话依赖 reasoning lease/timeout 机制，超出上下文窗口时直接失败。

**影响**：
- 长 reasoning session 容易超出模型上下文限制
- 无自动摘要机制保护关键信息
- 需要人工手动清理 chat history

**对比**：Claude 有 5 层压缩管道；Codex 有 Context Compaction；Hermes 框架原生有 ContextCompressor（但 Control 未使用）。

---

## 4. 补齐清单：分阶段

### 阶段 1：通用基础设施（已完成 ✅）

> 目标：让 Hermes 具备处理通用任务的基础能力

| # | 任务 | 状态 | 具体行动 |
|---|------|------|----------|
| 1.1 | 暴露 Web 搜索工具 | ✅ 已完成 | `toolRegistry.js` + `actionRegistry.js` 注册 `web.search`、`web.extract`；`webToolsService.js` 实现 Tavily/Brave 后端；`controlServerCore.js` 执行逻辑 + `promptBuilders.js` 参数说明 |
| 1.2 | 暴露浏览器工具 | ⏳ 待实现 | 需配置 browser 后端（headless Chromium），当前预留接口 |
| 1.3 | 启用 MCP 支持 | ✅ 框架已完成 | `mcpService.js` 创建配置读取 + 状态检测 + 预留调用接口；`toolRegistry.js` + `actionRegistry.js` + `controlServerCore.js` 注册 `mcp.call`；完整客户端连接需安装 `@modelcontextprotocol/sdk` |
| 1.4 | 添加 Shell 工具 | ✅ 已完成 | `toolRegistry.js` + `actionRegistry.js` 注册 `shell.execute`；`controlServerCore.js` 使用 `execAsync` 执行，cwd 限制在 `GAMESTUDIO_ROOT`，timeout/maxBuffer 保护 |
| 1.5 | 添加 Git 工具 | ✅ 已完成 | `toolRegistry.js` + `actionRegistry.js` 注册 `git.status`、`git.diff`、`git.log`、`git.branch`；`controlServerCore.js` 执行对应 git 命令并结构化输出 |
| 1.6 | 添加测试运行工具 | ✅ 已完成 | `toolRegistry.js` + `actionRegistry.js` 注册 `test.run`；自动检测 npm test/pytest/jest；`controlServerCore.js` 执行并解析 exitCode/stdout/stderr |
| 1.7 | 引入分级审批机制 | ✅ 已完成 | `controlServerCore.js` 实现 4 级模式：`suggest` / `auto-edit` / `full-auto` / `manual`；`shouldRequireHumanReviewForStep` 和 `shouldPauseBeforeExecutingReasoningStep` 按级别决策；`isLowRiskAction` / `isMediumRiskAction` 分类 |
| 1.8 | 启用上下文压缩 | ✅ 已完成 | `controlServerCore.js` `buildHermesChatMessages` 添加 `compressChatMessages`；`promptBuilders.js` `buildReasoningPlannerMessages` 添加 `compressPlannerMessages`；基于字符数估算 token，75% 阈值触发，保留系统消息 + 移除最旧历史对 |

### 阶段 2：多模态与视觉（2-3 个月）

> 目标：让 Hermes 具备视觉理解和生成能力

| # | 任务 | 具体行动 | 依赖 |
|---|------|----------|------|
| 2.1 | 集成 VLM 图片理解 | 暴露 `vision.analyze` 到 Control，支持分析 UI 截图、设计稿、参考图 | 需多模态模型（如 Qwen-VL、Gemma-3） |
| 2.2 | 集成视频理解 | 暴露 `video.analyze` 到 Control | 需视频模型 |
| 2.3 | 视觉审核锁定参考图 | 用 VLM 评审 `story_generate_lock_asset_references` 的产出质量 | 依赖 2.1 |
| 2.4 | Vision-to-Code | 支持从 UI mockup/截图生成 GameStudio Editor 的蓝图/合成配置 | 依赖 2.1 |
| 2.5 | 浏览器视觉问答 | 支持 `browser_vision` 在 Control 中使用 | 依赖 1.2 |

### 阶段 3：高级 Agent 能力（3-6 个月）

> 目标：让 Hermes 具备接近主流 Coding Agent 的自主性和效率

| # | 任务 | 具体行动 | 依赖 |
|---|------|----------|------|
| 3.1 | 子 Agent / 并行执行 | 实现 `delegate_task` 在 Control 中的集成；支持并行 step 执行 | 架构改动较大 |
| 3.2 | 动态规划 / 递归 Replanning | 实现 observe-plan-act 循环；步骤失败后自动调整计划 | 需设计状态机 |
| 3.3 | 代码索引 / 语义搜索 | 集成 tree-sitter 或 LSP，建立全仓库符号索引 | 需选择索引方案 |
| 3.4 | 结构化记忆系统 | 替换文件级 markdown，引入 embedding-based 记忆 + 自动事实抽取 | 需向量数据库 |
| 3.5 | 全仓库 AST 感知编辑 | 支持基于 AST 的精准编辑（重命名、提取函数等） | 依赖 3.3 |
| 3.6 | 自动测试驱动修复 | 运行测试 → 定位失败 → 生成修复 → 重试测试的闭环 | 依赖 1.6 |
| 3.7 | 夜间无人值守模式 | 配置夜间自动执行低风险 workflow（如 validate + export），高风险仍需审批 | 依赖 1.7 |

### 阶段 4：领域增强（持续）

> 目标：在故事生产领域超越通用 Agent

| # | 任务 | 具体行动 |
|---|------|----------|
| 4.1 | 打通 P1 图片资产闭环 | 参考 `HERMES_RUNTIME_AND_CONTROL_INTERACTION.md` 阶段 B |
| 4.2 | 多模态故事创作 | 支持从图片/视频灵感直接生成故事脚本和蓝图 |
| 4.3 | 智能资产审核 | VLM 自动审核背景图/角色图质量，替代人工 review |
| 4.4 | 自动 A/B 测试 | 生成多个故事版本，自动导出并对比结构差异 |
| 4.5 | 跨项目知识复用 | 从已完成的优秀项目中抽取模板和模式，应用到新项目 |

---

## 5. 能否达到类似 Kimi / Claude Code / Codex / ChatGPT 的功能？

### 5.1 直接回答

> **当前不能**。Hermes / GameStudio Control 是一个**垂直领域（互动故事生产）的半自动控制器**，在通用编码、Web 访问、多模态理解、自主执行等维度上与主流 AI Agent 存在**结构性差距**。
>
> 但通过系统性补齐（预计 **3-6 个月**），可以达到**"领域增强型 Agent"** 水平：
> - 在**故事生产领域**超越通用 Agent（更深的领域工具链、更专业的资产生成管道）
> - 在**通用编码任务**上接近主流水平（具备 Shell、Git、测试、Web 搜索等基础能力）
> - 在**多模态能力**上达到主流水平（图片理解+生成+视频分析）

### 5.2 差距收敛路径

```
当前状态：垂直领域半自动控制器
    │
    ├─ 阶段 1（1-2月）→ 通用基础设施补齐
    │     └─ Web 搜索、浏览器、MCP、Shell、Git、测试、分级审批
    │     └─ 状态：可处理通用编码任务（如"帮我修这个 bug"）
    │
    ├─ 阶段 2（2-3月）→ 多模态补齐
    │     └─ VLM、视频理解、视觉审核、Vision-to-Code
    │     └─ 状态：可分析 UI 截图、设计稿，从视觉素材创作故事
    │
    ├─ 阶段 3（3-6月）→ 高级 Agent 能力
    │     └─ 子 Agent、动态规划、代码索引、结构化记忆
    │     └─ 状态：接近 Claude Code / Cursor 的自主编码水平
    │
    └─ 阶段 4（持续）→ 领域增强
          └─ P1 资产闭环、多模态创作、智能审核、跨项目复用
          └─ 状态：在互动故事生产领域达到行业领先
```

### 5.3 与每个主流系统的具体对比

#### vs Kimi Code CLI / K2.5

**差距**：
- Kimi 支持 **Agent Swarm**（100 并行 agent），Hermes 无并行执行
- Kimi 支持 **Vision-to-Code**（从 UI 截图/视频生成代码），Hermes 无 VLM
- Kimi 支持 **Web Browsing**（BrowseComp 74.9%），Hermes 无浏览器
- Kimi 的 **Multi-Head Latent Attention** 降低 40-50% 内存带宽，Hermes 无此优化

**收敛后优势**：
- 在互动故事生产闭环上，Hermes 的 19 个专用工具 + ComfyUI 集成远超 Kimi 的通用工具
- 本地模型（OMLX）原生支持，适合离线/隐私场景

#### vs Claude Code

**差距**：
- Claude 有 **7 种权限模式 + ML 分类器**，Hermes 只有 binary review
- Claude 有 **200K 上下文 + 5 层压缩管道**，Hermes 无自动压缩
- Claude 有 **MCP 深度集成 + 插件/skills/hooks 四种扩展机制**，Hermes 未启用 MCP
- Claude 有 **Computer Use API**（屏幕控制），Hermes 无视觉输入

**收敛后优势**：
- Control-Console 双平面架构更适合生产级任务编排
- Story workflow 的质量门（reviewBlueprintAgent + validateProject）比 Claude 的通用代码审查更专业

#### vs Codex (OpenAI)

**差距**：
- Codex 有 **OS 级沙箱**（Seatbelt/seccomp/Windows ACL），Hermes 的脚本执行在白名单下直接运行
- Codex 有 **Plan Mode**（>3 文件变更先规划），Hermes 直接进入执行
- Codex 有 **Cloud 异步任务**（fire-and-forget），Hermes 无异步执行
- Codex 有 **多 surface 覆盖**（CLI/Desktop/IDE/Cloud/Chrome），Hermes 仅限 Control Console

**收敛后优势**：
- 资产生成管道（ComfyUI + 锁定事物 + 场景渲染）是 Codex 完全没有的领域能力
- 本地模型支持降低运营成本

#### vs ChatGPT (o3/o4)

**差距**：
- ChatGPT 有 **完整多模态**（图片理解+生成+语音+视频），Hermes 仅支持文生图
- ChatGPT 有 **跨会话 Memory + Projects**，Hermes 的记忆是文件级 markdown
- ChatGPT 有 **DALL-E 3 + Advanced Voice Mode**，Hermes 无语音交互
- ChatGPT 有 **Custom GPTs + GPT Store**，Hermes 的 skill 生态仅 1 个

**收敛后优势**：
- 故事生产的端到端闭环（从创意到可运行 H5）是 ChatGPT 无法直接完成的
- 本地部署 + 可控审核更适合企业内容生产场景

#### vs Cursor / Copilot

**差距**：
- Cursor 有 **全仓库语义索引 + .cursorrules**，Hermes 只有 ripgrep
- Cursor 有 **Background Agent**（云端 VM 自主运行并开 PR），Hermes 无云端执行
- Copilot 有 **GitHub 原生深度集成**（Issues/PRs/Actions/CI），Hermes 无 Git 能力
- Cursor/Copilot 有 **Inline diff review**，Hermes 的 review 是整步拦截

**收敛后优势**：
- 互动故事的专业编译/校验/导出工具链是 Cursor/Copilot 没有的
- Control 平面适合多人协作的内容生产流水线

---

## 6. 推荐的最小可行补齐方案（MVP）

如果资源有限，优先补齐以下 **5 项**，即可让 Hermes 具备处理 80% 通用任务的能力：

| 优先级 | 任务 | 预期效果 | 工作量 |
|--------|------|---------|--------|
| 1 | **暴露 web_search + web_extract** | 可获取外部文档、API 参考、技术方案 | 1-2 天 |
| 2 | **暴露 vision_analyze** | 可分析 UI 截图、设计稿、参考图 | 2-3 天 |
| 3 | **添加 shell.execute 工具** | 可运行 npm test、tsc、git status 等 | 2-3 天 |
| 4 | **启用 MCP 支持** | 可接入数据库、外部 API、代码质量工具 | 3-5 天 |
| 5 | **实现分级审批（3 级）** | Suggest（只读）/ Auto-Edit（低风险自动）/ Full-Auto（需配置） | 5-7 天 |

**总工作量**：约 **2-3 周**，即可让 Hermes 从"垂直领域半自动控制器"升级为"具备通用能力的领域增强型 Agent"。

---

## 附录：术语速查

| 术语 | 说明 |
|------|------|
| **MCP** | Model Context Protocol，Anthropic 提出的开放工具协议，允许 AI 动态接入外部工具 |
| **VLM** | Vision Language Model，视觉语言模型，可同时理解图片和文本 |
| **AST** | Abstract Syntax Tree，抽象语法树，代码的结构化表示 |
| **Review Gate** | 审核门禁，关键操作需人工确认后才执行 |
| **Quality Gate** | 质量门禁，模型自动评分，未通过需人工 override |
| **OMLX** | OpenML X，本地模型服务，`http://127.0.0.1:18888/v1` |
| **Reasoning Session** | 可观测执行路径，含 plan → step → review → quality gate |
| **Context Compaction** | 上下文压缩，token 超标时自动摘要旧消息以保护关键信息 |
| **Agent Swarm** | 多代理并行执行，同时调度多个子 agent 完成不同子任务 |
| **Vision-to-Code** | 从视觉输入（UI 截图、视频）生成代码的能力 |

---

*文档版本：2026-05-28*
*维护者：AI Agent 编码代理*
*下次更新时机：阶段 1 补齐完成后*
