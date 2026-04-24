# MEMORY - GameStudio Project Memory

## 项目使命

让 `control + hermes` 成为 GameStudio 的统一任务控制面，能够围绕故事项目执行完整链路：

项目创建 -> 项目配置 -> 故事/脚本生成 -> 图片与资产生成 -> 项目验证 -> 导出交付

## 权威事实

- 前端编辑器目录：`apps/editor`
- 业务后端目录：`apps/server`
- 控制台前端目录：`apps/control-console`
- 控制台后端目录：`apps/control-server`
- 项目创建目录：`storage/projects`
- demo 素材目录：`storage/demo_library`
- 若配置 `STUDIO_STORAGE_ROOT`，则以外部 storage 根目录为准

## 当前工作方式

- 普通聊天用于短问题和直接执行。
- reasoning / 可观测执行用于多步骤长任务。
- 对项目扫描类任务，必须显式返回扫描目录、缺失目录和证据不足原因。
- 长任务方向详见 `ai/memory/LONG_TASKS.md`。
- 当前短任务队列详见 `ai/memory/TASK_QUEUE.md`。

## 长任务主线

1. 建立 control 驱动的故事项目创建流程。
2. 建立项目配置与模板装配流程。
3. 建立故事脚本、蓝图与场景规划生成流程。
4. 建立图片与资产生成、入库、回填流程。
5. 建立项目验证、导出与交付流程。

## 当前重点

- 已修正 Hermes 普通聊天的当前会话记忆窗口。
- 已修正 reasoning 对 `storage/projects` 的扫描路径。
- 已修正 stories 空结果时必须返回明确结论。
- 下一阶段聚焦“control 驱动 Hermes 创建和配置故事项目”。
