# GameStudio 工作区 Skill

当 HermesManager 在 GameStudio 工作区内启动、问答、做可观测执行时使用本 skill。

## 目标

在不扫描整个仓库的前提下，为 `control + hermes` 提供稳定、最小、可持续增强的项目上下文。

这个 skill 可以使用中文，也应该优先使用中文来描述项目规则、目录职责、审核要求和提交约束。

## 必读文件

1. README.md
2. docs/CONTROL_SYSTEM.md
3. docs/DESIGN_WORKFLOW_3_LAYERS.md
4. ai/USER.md
5. ai/MEMORY.md

当问题明确涉及当前项目状态时，再按需读取：

1. ai/memory/STATUS.md
2. ai/memory/TASK_QUEUE.md
3. ai/memory/DECISIONS.md
4. ai/memory/当日日志

## 路由规则

- 如果任务提到 control、Hermes、管理器、可观测执行，优先停留在 apps/control-console 和 apps/control-server。
- 如果任务提到 editor、前端编辑器、三层工作流，优先停留在 apps/editor。
- 如果任务提到 server、图片生成、项目创建、故事资产，优先停留在 apps/server。
- 不要为了“增加信心”扫描无关模块。

## 与 Control 配合的规则

- Hermes 必须接受 control-console 在提交前注入的已确认上下文、上下文池记录和临时回放窗口设置。
- 如果 control-console 明确传入可编辑后的消息数组，应以该数组作为本次真正发送给模型的内容，而不是再自行重建另一份不同的 prompt。
- 如果 control-console 明确关闭某条上下文源或某条上下文池记录，本次请求中不得私自补回。

## Startup 约束

- 使用 HermesManager 当前配置的 provider / model / baseUrl。
- ai/USER.md 和 ai/MEMORY.md 视为长期记忆输入。
- ai/memory/*.md 视为项目状态输入，只在问题确实需要时载入。
- manager 当前仍以 left-brain 为主；right-brain 在 manager 侧完全启用前不参与执行。

## 审核与预览规则

- reasoning session 是分段审核的，进入 `waiting_review` 后必须等待显式审核，不要跳过。
- 如果审核被驳回，修正条件是本轮唯一权威约束，只重做被驳回的目标。
- 在计划审核、步骤审核、答案评分审核时，都要同时暴露发出的请求预览和模型首轮返回结果，便于人工核对。
- 提交前预览不是装饰信息，而是实际可编辑发送内容；如果用户改了，就按用户改后的内容执行。

## 上下文池规则

- 上下文池只保存“已经人工确认过、后续值得复用”的事实摘要，不保存原始长对话流水。
- 如果用户确认某次预览摘要准确，可将其沉淀到上下文池，供后续同类任务直接复用。
- 对话历史本身不等于上下文池；只有被确认并写入的摘要，才算进入上下文池。

## 可观测规则

- 对 stories / scripts / 项目目录的问题，不要在本地工具运行前猜数据库、API 或外部目录。
- 对“当前已有项目”“故事扫描”类问题，优先使用 `storage/projects/*/scripts.json` 的本地结果。
- 对图片生成入口问题，优先使用 apps/server/src 内的服务端入口证据。
- 优先给出可验证、可定位的仓库内事实，不要给出泛化架构猜测。

## Planner Action Hints

- editor|编辑器|前端目录|frontend|目录在哪里 => locate_project, generate_default_answer
- 业务后端|后端目录|server目录|backend directory|apps/server => locate_project, generate_default_answer
- control|Hermes|管理器|reasoning|对话|聊天|后端文件|主要后端|backend => locate_project, inspect_control_backend_surfaces, generate_default_answer
- story|stories|脚本|scripts.json|项目扫描|已创建故事 => locate_project, list_created_stories, summarize_story_index
- 图片生成|出图|image|background|comfyui|服务端入口 => locate_project, inspect_server_image_entrypoints, generate_default_answer

## 持续增强原则

这个 skill 可以持续增强，但只能增强与当前 GameStudio `control + hermes` 真实工作流直接相关的规则：

- 可以增加新的项目目录职责说明。
- 可以增加新的可观测任务路由规则。
- 可以增加新的审核、预览、上下文池沉淀规范。
- 不要重新引入与当前项目无关的旧系统、旧代理、旧平台残留说明。
