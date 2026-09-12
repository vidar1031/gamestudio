# AGENTS - GameStudio Control / Hermes Contract

本文件是 GameStudio 当前对 Hermes 的工作契约。只保留与本项目、`control`、`hermes` 真实协作相关的规则。

## 核心定位

- `apps/control-server` 是 Hermes 的权威控制入口。
- `apps/control-console` 是权威操作界面。
- Hermes 负责执行任务、生成计划、读取项目事实、返回可验证结果。

## 默认读取顺序

1. `docs/PROJECT_GOVERNANCE.md`（**最高级治理规则，必须首先遵守**）
2. `README.md`
3. `ai/USER.md`
4. `ai/MEMORY.md`
5. `ai/memory/LONG_TASKS.md`
6. `ai/memory/STATUS.md`
7. `ai/memory/TASK_QUEUE.md`
8. `ai/memory/DECISIONS.md`
9. `ai/TOOLS.md`（当任务需要命令、接口、端口或目录细节时）
10. `ai/interactive_story_editor.contract.md`（当任务明确涉及 editor schema / UI 契约时）

当任务明确涉及 `control`、`control-server`、`control-console`、`Hermes manager` 结构或接口时，追加读取：

11. `ai/control_architecture.md`
12. `docs/系统生产级推进方案.md`（当任务涉及系统分工、启动流程和边界时）
13. `docs/PRODUCTION_DEFECTS.md`（当任务涉及生产链路和当前缺陷时）

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
- **禁止读取 `memory/` 根目录下的任何文件（该目录已弃用）**

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

- **所有更新必须遵守 `docs/PROJECT_GOVERNANCE.md` 的文档治理规则。**
- 长任务方向变化：更新 `ai/MEMORY.md` 或 `ai/memory/LONG_TASKS.md`
- 短任务变化：更新 `ai/memory/TASK_QUEUE.md`
- 当前目标 / 阻塞 / 下一步变化：更新 `ai/memory/STATUS.md`
- 新的稳定取舍：更新 `ai/memory/DECISIONS.md`
- 当日日志由系统自动写 `ai/memory/daily/`（如 `2026-05-18.md`），禁止手工创建日期日志；当日进展直接更新 `STATUS.md`，详细过程进入 `state/` 或测试 artifacts
- 当多步骤执行改变了项目状态、流程规则或当前主线时，必须在最终回答前同步上述记忆文件，而不是只更新聊天历史。

## 硬性生产规则（不可被模型覆盖）

以下规则是 GameStudio 交互故事生产系统的核心契约，**无论本地模型分类结果如何，必须通过确定性规则强制执行**：

### 1. Control → GameStudio 交互契约
- Control 是所有故事生产操作的**唯一入口**。
- 任何涉及 `创建故事`、`生成脚本`、`编译蓝图`、`导出项目` 的操作，必须走 Control 的 `agent-runtime-sessions` 或 reasoning 链路。
- 禁止绕过 Control 直接调用 GameStudio Server API 进行故事生产。

### 2. 故事生产工作流强制规则
- **正式工作流法律（2026-09-09 用户指令，最高优先级，不可绕过）**：任何故事生产动作**必须走本节的正式生产工作流链**（`story_workflow_execute` 分步计划）。每一步必须有可观测记录（reasoning session 事件流 + `/api/tasks` 进度 + 审核记录）；**任何一步失败必须显式停止**（failed/blocked 等待人工处置），禁止带病继续执行后续步骤。**禁止用零散 API/事件的即席组合替代正式工作流**——事件分发只用于正式链内的确定性步骤与经批准的修补动作，不得作为生产主路径。生产任务默认 reviewMode=manual（计划先审、逐步骤可审），仅用户明确授权才可 full-auto。
- 用户输入包含以下关键词时，**强制**走 `story_workflow_execute`，不依赖模型判断：
  - 创建/新建/生成/生产 + 故事
  - 一口气 + 故事
  - 完整/闭环 + 故事
  - 互动故事、故事项目
  - 大纲、脚本、分镜、资产、出图
  - interactive story、story workflow
- **收窄说明（R013，2026-08-19 起生效）**：问句形态优先于关键词强制。命中咨询问句形态（吗/呢/么 结尾或带问号、能不能/能否/可以…吗/会不会/是不是/是什么/为什么/如何/先回答/先告诉我 等）的输入，即使含上述生产关键词，也先走 `answer_only` 咨询路径（滚动压缩探索），**不触发**本强制工作流；仅祈使句（创建/生成/开始/执行…）适用本规则。取舍记录见 `ai/memory/DECISIONS.md`，实现见 `apps/control-server/src/server/reasoning/requestClassificationRules.js` 的 `R013_consultative_question_form`。
- 现行完整全链路为 **22 步**（权威说明见 `docs/狼来了内容质量闭环工作流.md`）：P0 文本 12 步 + P1 分层合成 6 步 + 记忆同步×3（STATUS/TASK_QUEUE/DECISIONS）+ 最终回答。其中 P0 文本链路（含最终回答共 13 步）不可跳过：
  1. `story_create_project` — 创建项目
  2. `story_configure_project` — 写入配置
  3. `story_generate_scripts_candidate` — 生成脚本候选
  4. `story_write_scripts` — 写入脚本
  5. `story_create_bible` — 生成 Story Bible
  6. `story_compile_blueprint` — 编译蓝图
  7. `story_review_blueprint_agent` — 蓝图评审
  8. `story_repair_blueprint_if_needed` — 修复蓝图
  9. `story_preflight_image_provider` — 图片预检
  10. `story_compile_compose` — 编译合成
  11. `story_validate_project` — 项目校验
  12. `story_export_project` — 导出项目
  13. `generate_default_answer` — 生成最终回答
- P1 分层合成 6 步（声明「背景+立绘分层合成/全链路交付」时追加在 P0 导出之后）：`story_create_asset_plan` 资产计划 → `story_generate_lock_asset_references` 透明立绘绘制锁定 → `story_render_scene_backgrounds` 背景批量渲染 → `story_generate_scene_placements` placements 立绘站位 → `story_validate_project` 校验 → `story_export_project` 重新导出。

### 3. 本地模型能力不足时的兜底策略
- 当本地模型（OMLX）分类错误或生成质量不达标时：
  - 分类层优先使用**规则表关键词匹配**，不依赖模型判断。
  - 故事脚本生成若出现截断、乱码、结构错误，必须触发重试或降级策略。
  - 蓝图编译失败时，必须返回具体错误信息，不能静默跳过。

### 4. 测试与验收规则
- 所有功能测试必须通过 Control Console 聊天窗口驱动，在 UI 中可观测、可追踪。
- S0（系统启动）→ L1（交互测试）→ L4（文本闭环）→ P1（图片资产）阶段必须依次通过。
- 前一阶段未通过，不得进入下一阶段。

## 响应规则

- 默认中文。
- 结论优先，避免长篇铺垫。
- 能直接执行的事，先执行再汇报。
- 涉及删除、外部写操作或高风险改动时，再向用户确认。
