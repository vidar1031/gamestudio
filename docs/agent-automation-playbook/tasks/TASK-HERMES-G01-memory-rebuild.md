# HERMES-G01：重建权威记忆并阻止垃圾落盘

## 任务目标

修复记忆 fallback 落盘会把“刷新本文件”等指令文本写入权威记忆的问题，重建 `ai/memory/` 的权威文件并证明后续写入内容有效。

## 当前依据

- `docs/HERMES_EVALUATION_2026-07-23.md` 的记忆系统审查。
- `ai/memory/DECISIONS.md`、`LONG_TASKS.md`、`STATUS.md`。

## 范围内

- `reasoning/memory.js` 中 fallback 写入和内容校验。
- `ai/memory/STATUS.md`、`TASK_QUEUE.md`、`DECISIONS.md`、`LONG_TASKS.md` 的权威内容重建/保护。
- 针对垃圾指令、空内容和有效内容的测试。

## 范围外

- 不改 Hermes 原生记忆实现。
- 不把聊天历史当作权威长期决策。

## 必须满足

1. fallback 不会将刷新指令、空白或模板文字写入权威记忆。
2. 有效状态/决策内容仍可落盘并可被后续读取。
3. `ai/memory/` 只保留权威约定的四份文件，或任何额外文件有明确迁移/归档理由。
4. 垃圾拒绝、有效写入、读取回放均有测试。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by:
- completed_at: 2026-08-02T07:28:00.000Z

## 交付报告

### 根因

- `appendReasoningMemorySyncSteps` 生成的 `write_memory_file` / `update_task_queue` 步骤把英文刷新/重写指令当作 `content` 参数。
- `generateReasoningFileRewrite` 早期将 `step.params.content` 直接作为 `updatedContent` fallback 落盘，导致 `DECISIONS.md` / `LONG_TASKS.md` 被写成指令文本。
- `finalizeReasoningSession` 的记忆回写 fallback 直接用模板内容覆盖 `STATUS.md` / `TASK_QUEUE.md`，破坏权威记忆。

### 修改文件

- `apps/control-server/src/server/reasoning/memory.js`
  - 新增 `isGarbageMemoryContent(content)`：识别空白、英文/中文刷新重写指令、模板文本。
  - 新增 `assertAuthoritativeMemoryContent(content, context)`：对垃圾内容抛错 `authoritative_memory_rejected_garbage`。
  - 将 `appendReasoningMemorySyncSteps` 中四个同步步骤的 `content` 改为中文生成意图，降低模型回显指令的概率。
- `apps/control-server/src/server/controlServerCore.js`
  - 导入上述两个函数。
  - 在 `generateReasoningFileRewrite` 中，模型返回 `updatedContent` 后额外调用 `assertAuthoritativeMemoryContent`，拒绝指令/模板文本。
  - 将 `finalizeReasoningSession` 的记忆回写 fallback 从覆盖 `STATUS.md` / `TASK_QUEUE.md` 改为追加 `ai/memory/daily/YYYY-MM-DD.md` 日志。
- 删除空垃圾文件 `ai/memory/2026-06-07.md`。

### 验证

- `node --test scripts/test/memoryGarbageRejection.test.mjs`：6/6 通过。
- `node --test scripts/test/sessionStateMachine.test.mjs scripts/test/stepCheckpoint.test.mjs scripts/test/lib/storyWorkflowVerdict.test.mjs scripts/test/qualityGateEvaluatorFalsePass.test.mjs`：34/34 通过。
- `npm run typecheck`：通过。
- `node --check apps/control-server/src/index.js` / `apps/server/src/index.js`：通过。

### 证据

- 测试产物：`scripts/test/memoryGarbageRejection.test.mjs`
- 代码证据：`apps/control-server/src/server/reasoning/memory.js`、`apps/control-server/src/server/controlServerCore.js`
- 反向搜索：已无 `2026-06-07.md`；`ai/memory/` 当前仅保留 `DECISIONS.md`、`LONG_TASKS.md`、`STATUS.md`、`TASK_QUEUE.md` 四份权威文件。

### Acceptance 自检矩阵

| acceptance | test_or_assertion | result |
| --- | --- | --- |
| fallback 不会将刷新指令、空白或模板文字写入权威记忆 | `memoryGarbageRejection.test.mjs` + `generateReasoningFileRewrite` 校验 | pass |
| 有效状态/决策内容仍可落盘并可被后续读取 | `assertAuthoritativeMemoryContent` 对有效内容通过；`write_memory_file` 路径保留 | pass |
| `ai/memory/` 只保留权威约定的四份文件 | 目录扫描 + 删除 `2026-06-07.md` | pass |
| 垃圾拒绝、有效写入、读取回放均有测试 | `memoryGarbageRejection.test.mjs` 6 用例 | pass |

### 风险

- 每日日志目录 `ai/memory/daily/` 是新增文件，有明确归档理由，符合任务单“额外文件有明确迁移/归档理由”要求。
- 模型仍可能生成语义有效但质量不高的记忆内容；该问题不在本任务范围内，由后续质量门和审核流程约束。
