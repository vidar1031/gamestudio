## In Progress

阶段 0 已全部完成，下一段进入阶段 1：A01 -> A02 与真实 P0 回归（依据 `docs/agent-automation-playbook/12-自动生产系统总实施与测试计划.md`）。

## Completed

### HERMES-G04：清理 story_scripts_candidate 死路由

- task_file: `docs/agent-automation-playbook/tasks/TASK-HERMES-G04-dead-route-cleanup.md`
- priority: P0
- dependency: none
- status: completed
- evidence:
  - `apps/control-server/src/server/controlServerCore.js` 的 `buildDefaultModelRoutingConfig` 已移除 `story_scripts_candidate` phaseRoute 与 `strictRouteRequiredPhases` 条目。
  - `config/hermes/manager.left-brain.json` 的 `workflow.modelRouting` 已同步移除 `story_scripts_candidate` 路由与严格阶段声明。
  - 脚本生成实际由 GameStudio Server 负责，Control 侧不再保留该 dead route；`story_blueprint_review` 仍为 Control 侧唯一保留的严格路由阶段。
  - 文档更新：`docs/HERMES_EVALUATION_2026-07-23.md`、`docs/系统生产级推进方案.md` 已按实际调用路径修正。
  - 回归：`node --check apps/control-server/src/index.js` 通过；`npm --workspace @game-studio/control-console run typecheck` 通过。

### HERMES-G03：聊天提交前确认可用性

- task_file: `docs/agent-automation-playbook/tasks/TASK-HERMES-G03-chat-submit-gate.md`
- priority: P0
- dependency: none
- status: completed
- evidence:
  - `apps/control-console/src/pages/ChatPage.vue`：提交前确认门改为固定居中弹窗（`.chat-gate-backdrop` + `.chat-gate-modal`），点击遮罩可关闭，避免发送后界面无响应。
  - `apps/control-console/src/composables/useControlConsoleApp.ts` 新增 `rejectSubmitGate`：关闭弹窗并清空输入框与草稿，提供“返回/取消/拒绝/确认”四种明确操作。
  - 自动直跑模式逻辑不变：`sendObservableReasoningChat` 在 `reasoningAutoApproveEnabled=true` 时仍直接调用 `performReasoningSubmission`。
  - 回归：`npm --workspace @game-studio/control-console run typecheck` 通过；`node --check apps/control-server/src/index.js` 通过。

### HERMES-G01：重建权威记忆并阻止垃圾落盘

- task_file: `docs/agent-automation-playbook/tasks/TASK-HERMES-G01-memory-rebuild.md`
- priority: P0
- dependency: none
- status: completed
- evidence:
  - `apps/control-server/src/server/reasoning/memory.js` 新增 `isGarbageMemoryContent` / `assertAuthoritativeMemoryContent`。
  - `apps/control-server/src/server/controlServerCore.js` 在 `generateReasoningFileRewrite` 中调用校验，拒绝指令/模板/空白文本。
  - 记忆回写 fallback 改为追加每日日志，不再覆盖 `STATUS.md` / `TASK_QUEUE.md`。
  - 删除垃圾文件 `ai/memory/2026-06-07.md`。
  - 测试：`scripts/test/memoryGarbageRejection.test.mjs` 6/6 通过。
  - 回归：`scripts/test/sessionStateMachine.test.mjs` 等 34/34 通过；`npm run typecheck` 通过；后端 syntax check 通过。

### HERMES-G02：supervision 401 收敛

- task_file: `docs/agent-automation-playbook/tasks/TASK-HERMES-G02-supervision-guard.md`
- priority: P0
- dependency: none
- status: completed
- evidence:
  - `apps/control-server/src/server/controlServerCore.js` 新增 `isAuthFailureError`、`stopSupervisionTimer`、`getSupervisionTimerState`。
  - `registerPrimaryControlServerRoutes` 定时器改为可管理句柄；遇 401 自动 clearInterval/clearTimeout 并记录恢复条件。
  - `triggerSupervision` 捕获 401/认证错误后调用 `stopSupervisionTimer`，禁止后续空转。
  - 默认 `SUPERVISION_ENABLED !== 'true'` 时定时器不启动；启用后运行中遇 401 也会收敛。
  - 测试：`scripts/test/supervisionAuthGuard.test.mjs` 3/3 通过。
  - 回归：`scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 43/43 通过；`npm run typecheck` 通过；后端 syntax check 通过。

## Ready（待处理）

（当前无待处理任务；阶段 0 完成后自动进入阶段 1。）

## 总执行规则

- 全部执行顺序与阶段门以 `docs/agent-automation-playbook/12-自动生产系统总实施与测试计划.md` 为准。
- 阶段 0 执行顺序为 G01 -> G02 -> G03 -> G04；通过后自动进入阶段 1 的 A01 -> A02 与真实 P0 回归。
- Kimi 在每个 task 内完成自身验收后自动领取下一依赖 task；阶段门通过后自动继续下一阶段，不等待逐 task 人工确认。
- AUTO-B03 至 AUTO-F02 是总计划的阶段 2-4 任务，必须按依赖执行，不是冻结任务。

updatedAt: 2026-08-02T07:59:52.000Z
