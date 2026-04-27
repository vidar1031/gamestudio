# GameStudio

GameStudio 是一个 H5 互动故事生成工具仓库，当前主方向是让 `control` 驱动 `Hermes` 完成故事项目的创建、配置、生成与验证。

## 当前目标

- 由 `apps/control-console` + `apps/control-server` 作为控制平面。
- 由 Hermes 作为执行代理，完成项目管理、计划生成、内容生成和图片生成相关任务。
- 由 `apps/editor` 和 `apps/server` 作为实际业务前后端。
- 由 `storage/projects` 作为项目创建与持久化目录。

## 权威目录

- 前端编辑器：`apps/editor`
- 业务后端：`apps/server`
- 控制台前端：`apps/control-console`
- 控制台后端：`apps/control-server`
- 项目存储根：`storage`
- 项目创建目录：`storage/projects`
- Demo 素材库：`storage/demo_library`
- Hermes 项目记忆：`ai/`
- Hermes 控制配置：`config/hermes/`

如果设置了 `STUDIO_STORAGE_ROOT`，则 `apps/server` 以外部目录下的 `projects/` 与 `demo_library/` 为准。

## 快速启动

首次使用：

- `npm install`

业务服务：

- 启动：`./start_project.sh`
- 后台启动：`./start_project.sh --detached`
- 状态：`./status_project.sh`
- 停止：`./stop_project.sh`

控制平面：

- 重启 control：`sh restart_control.sh`

## 端口

- GameStudio Server: `http://127.0.0.1:1999`
- GameStudio Editor: `http://localhost:8868`
- Control Server: `http://127.0.0.1:2099`
- Control Console: `http://127.0.0.1:8870`

## Hermes / Control 权威输入文件

这些文件是 control 当前默认注入给 Hermes 的项目事实源：

- `ai/AGENTS.md`
- `ai/USER.md`
- `ai/MEMORY.md`
- `ai/memory/STATUS.md`
- `ai/memory/TASK_QUEUE.md`
- `ai/memory/DECISIONS.md`
- `ai/memory/YYYY-MM-DD.md` 中的最新当日日志

辅助文件：

- 长任务清单：`ai/memory/LONG_TASKS.md`
- 工具清单：`ai/TOOLS.md`
- 编辑器契约：`ai/interactive_story_editor.contract.md`

## 当前任务组织方式

- 长任务：放在 `ai/memory/LONG_TASKS.md`
- 短任务：放在 `ai/memory/TASK_QUEUE.md`
- 当前状态：放在 `ai/memory/STATUS.md`
- 生效中的规则与取舍：放在 `ai/memory/DECISIONS.md`
- 用户偏好与协作边界：放在 `ai/USER.md`
- 工具与命令：放在 `ai/TOOLS.md`

## 当前工作方式

- 普通聊天用于短问题、状态查询、直接执行。
- 可观测执行用于多步骤长任务，必须产出可审核的计划和显式结论。
- 对 `stories` / 项目扫描类任务，若找不到结果，必须明确返回：
  - 扫描了哪些目录
  - 哪些目录缺失
  - 当前为什么不足以继续判断

## 相关文档

- 控制系统说明：`docs/CONTROL_SYSTEM.md`
- Hermes 管理配置：`docs/HERMES_MANAGER_CONFIG.md`
- 三层工作流：`docs/使用说明_三层工作流.md`
- 交互故事编辑器契约：`ai/interactive_story_editor.contract.md`
- 页内编辑器是:vue-codemirror