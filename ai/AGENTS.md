# AGENTS - GameStudio Control / Hermes Contract

本文件是 GameStudio 当前对 Hermes 的工作契约。只保留与本项目、`control`、`hermes` 真实协作相关的规则。

## 核心定位

- `apps/control-server` 是 Hermes 的权威控制入口。
- `apps/control-console` 是权威操作界面。
- Hermes 负责执行任务、生成计划、读取项目事实、返回可验证结果。

## 默认读取顺序

1. `README.md`
2. `ai/USER.md`
3. `ai/MEMORY.md`
4. `ai/memory/LONG_TASKS.md`
5. `ai/memory/STATUS.md`
6. `ai/memory/TASK_QUEUE.md`
7. `ai/memory/DECISIONS.md`
8. 最新的 `ai/memory/YYYY-MM-DD.md`
9. `ai/TOOLS.md`（当任务需要命令、接口、端口或目录细节时）
10. `ai/interactive_story_editor.contract.md`（当任务明确涉及 editor schema / UI 契约时）

当任务明确涉及 `control`、`control-server`、`control-console`、`Hermes manager` 结构或接口时，追加读取：

11. `ai/control_architecture.md`

## 权威目录事实

- 编辑器：`apps/editor`
- 业务后端：`apps/server`
- 控制台前端：`apps/control-console`
- 控制台后端：`apps/control-server`
- 项目存储根：`storage`
- 项目创建目录：`storage/projects`
- Demo 素材目录：`storage/demo_library`
- 若设置 `STUDIO_STORAGE_ROOT`，则以外部 storage 根目录为准

## 状态源

- 长任务方向：`ai/MEMORY.md` 与 `ai/memory/LONG_TASKS.md`
- 短任务推进：`ai/memory/TASK_QUEUE.md`
- 当前目标、阻塞、下一步：`ai/memory/STATUS.md`
- 生效中的规则：`ai/memory/DECISIONS.md`
- 当日关键进展：最新的 `ai/memory/YYYY-MM-DD.md`

## 工作规则

- 对项目路径、目录结构、任务状态的判断，以文件事实为先，不以旧聊天印象为先。
- 对 `control` 结构、路由归属、console/service 对齐关系的判断，以 `ai/control_architecture.md` 为先。
- 普通聊天用于短问题、直接执行和状态查询。
- 多步骤任务使用 reasoning / 可观测执行，并且必须给出显式结论。
- stories / 项目扫描类任务必须优先扫描 `storage/projects`，并在结果里明确返回：
  - 已扫描目录
  - 缺失目录
  - 证据不足原因
- 未观测到的 assets、scenes、props、图片生成状态，不得编造成“已扫描事实”。

## 更新规则

- 长任务方向变化：更新 `ai/MEMORY.md` 或 `ai/memory/LONG_TASKS.md`
- 短任务变化：更新 `ai/memory/TASK_QUEUE.md`
- 当前目标 / 阻塞 / 下一步变化：更新 `ai/memory/STATUS.md`
- 新的稳定取舍：更新 `ai/memory/DECISIONS.md`
- 当日关键进展：更新当日 `ai/memory/YYYY-MM-DD.md`
- 当多步骤执行改变了项目状态、流程规则或当前主线时，必须在最终回答前同步上述记忆文件，而不是只更新聊天历史。

## 响应规则

- 默认中文。
- 结论优先，避免长篇铺垫。
- 能直接执行的事，先执行再汇报。
- 涉及删除、外部写操作或高风险改动时，再向用户确认。
