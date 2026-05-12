---
name: gamestudio-workspace
description: 'Use when HermesManager handles GameStudio workspace chat, submission preview, or observable execution in the control + hermes workflow. Keywords: control, Hermes, manager, reasoning, context pool, observable execution.'
user-invocable: false
---

# GameStudio Workspace Skill

当 HermesManager 在 GameStudio 工作区内做普通问答、提交前预览或可观测执行时使用本 skill。

## 作用边界

这个 skill 只保留两类信息：

1. GameStudio `control + hermes` 提交链路里的专属执行约束。
2. 为减少全仓扫描而提供的最小路由提示。

项目事实、目录真相源、长短期状态和稳定规则，以 `ai/AGENTS.md`、`ai/MEMORY.md` 与 `ai/memory/*.md` 为准，不在这里重复展开。

## 最小读取入口

1. `README.md`
2. `ai/AGENTS.md`
3. `ai/MEMORY.md`

仅当问题明确涉及当前状态、任务推进或稳定规则时，再按需读取：

1. `ai/memory/LONG_TASKS.md`
2. `ai/memory/STATUS.md`
3. `ai/memory/TASK_QUEUE.md`
4. `ai/memory/DECISIONS.md`
5. 当天 `ai/memory/YYYY-MM-DD.md`

## 提交链路约束

- 必须接受 control-console 在提交前注入的已确认上下文、上下文池记录和临时回放窗口设置。
- 如果 control-console 明确传入可编辑后的消息数组，应以该数组作为本次真正发送给模型的内容，而不是再自行重建另一份 prompt。
- 如果 control-console 明确关闭某条上下文源或上下文池记录，本次请求中不得私自补回。
- 使用 HermesManager 当前配置的 provider、model、baseUrl；right-brain 未完全启用前，不参与执行。

## 审核与预览约束

- reasoning session 进入 `waiting_review` 后必须等待显式审核，不得跳过。
- 如果审核被驳回，修正条件是本轮唯一权威约束，只重做被驳回目标。
- 计划审核、步骤审核、答案评分审核时，都应同时暴露请求预览和模型首轮返回，便于人工核对。
- 提交前预览是实际可编辑发送内容；如果用户修改，必须按修改后的内容执行。

## 上下文池约束

- 上下文池只保存已人工确认、后续值得复用的事实摘要，不保存原始长对话流水。
- 只有被确认并写入的摘要，才算进入上下文池；聊天历史本身不等于上下文池。

## 最小路由提示

- 提到 `control`、`Hermes`、管理器、可观测执行，优先停留在 `apps/control-console` 和 `apps/control-server`。
- 提到 editor、前端编辑器、三层工作流，优先停留在 `apps/editor`。
- 提到 server、图片生成、项目创建、故事资产，优先停留在 `apps/server`。
- 不要为了增加信心扫描无关模块。

## 可观测执行提示

- 对 stories、scripts、项目目录问题，先看本地仓库证据，不要先猜数据库、外部 API 或外部目录。
- 对“扫描 storage/projects”“列出当前已有项目”这类目录问题，先列目录并把真实目录结果交给模型分析。
- 只有当用户明确要求故事内容、脚本节点、标题或 `scripts.json` 细节时，才继续读取 `storage/projects/*/scripts.json`。
- 对图片生成入口问题，优先使用 `apps/server/src` 内的服务端入口证据。
- 结论必须可验证、可定位，避免泛化架构猜测。

## Planner Action Hints

- editor|编辑器|前端目录|frontend|目录在哪里 => locate_project, generate_default_answer
- 业务后端|后端目录|server目录|backend directory|apps/server => locate_project, generate_default_answer
- control|Hermes|管理器|reasoning|对话|聊天|后端文件|主要后端|backend => locate_project, inspect_control_backend_surfaces, generate_default_answer
- 图片生成|出图|image|background|comfyui|服务端入口 => locate_project, inspect_server_image_entrypoints, generate_default_answer
- 启动 GameStudio|打开 Editor|settings|本地生产配置|自检|diagnose => gamestudio_ensure_running, gamestudio_read_settings, gamestudio_self_check, generate_default_answer
- 配置本地 OMLX|配置 ComfyUI|图片 provider 预检 => gamestudio_read_settings, gamestudio_configure_local_production, gamestudio_self_check, generate_default_answer
- 创建互动故事|story workflow|故事项目生产|文本故事闭环 => story_create_project, story_inspect_project, generate_default_answer
- 写入故事配置|生成 scripts|编译蓝图|编译合成层|校验项目|导出 H5 => story_configure_project, story_generate_scripts_candidate, story_write_scripts, story_compile_blueprint, story_compile_compose, story_validate_project, story_export_project, generate_default_answer
- 资产计划|角色资产|背景图资产|图片资产闭环 => story_preflight_image_provider, story_create_asset_plan, story_generate_asset_candidate, story_validate_project, generate_default_answer
- 记忆状态|任务队列|决策记录|上下文池|清理记录 => read_recent_context, generate_default_answer
- 生产测试|L1|L4|L5|control_production_test => run_workspace_script, generate_default_answer
- 可观测执行|黑盒|gamestudio_observer|endpoint 证据 => story_inspect_project, generate_default_answer

## 迭代原则

- 可以迭代增加新的提交链路约束、审核约束、上下文池约束和最小路由提示。
- 不要把 `AGENTS.md`、`MEMORY.md`、`DECISIONS.md` 里的长期事实整段复制进来。
- 如果某条规则已经进入 `ai/AGENTS.md` 或 `ai/memory/DECISIONS.md`，这里应只保留对 skill 执行真正必要的简写入口，而不是再写第二份完整说明。
