# GameStudio Memory Lifecycle

## 目标

Control Server 需要保存足够的上下文，让 Hermes 重启后仍能理解当前项目状态；但记忆不能无限增长，也不能把旧结论、失败样本、测试噪声持续注入 planner。

记忆系统的目标不是“都保存”，而是让每条记录处在明确生命周期里：醒着、睡眠、归档或删除。

## 分层

### 1. 运行态记录

来源：reasoning session、runtime events、review records、chat turn、model request telemetry。

用途：审计、复盘、调试。

默认状态：`ephemeral`。

规则：

- 活跃 session 必须完整保留。
- completed / failed / cancelled session 不默认进入模型上下文。
- 只在用户追问具体 session、测试报告、失败复盘时被唤醒。
- 超过保留窗口后保留摘要和索引，原始大字段可归档或删除。

### 2. 浅记忆

来源：context pool、普通聊天总结、单次测试结论、未晋级 proposal。

用途：辅助回忆，不作为事实真相源。

默认状态：`sleeping`。

规则：

- 默认不注入 planner。
- 只有 prompt 命中特定 topic、caseId、sessionId、文件路径或用户手动选择时才唤醒。
- 长期未访问、低置信、被后续记录覆盖时转入 `archived`。

### 3. 深记忆

来源：`ai/MEMORY.md`、`ai/memory/DECISIONS.md`、`LONG_TASKS.md`、`STATUS.md`、经过人工确认的 context pool 或 promoted intent/workflow 规则。

用途：启动后恢复项目理解、约束 planner、决定 workflow 路由。

默认状态：`awake`，但必须有预算。

规则：

- `STATUS.md` 是当前状态，只保留最新事实，不追加历史流水。
- `TASK_QUEUE.md` 只保留活跃短任务；完成项必须移除或转入报告。
- `LONG_TASKS.md` 只保留跨会话主线和验收标准。
- `DECISIONS.md` 只保留稳定规则；临时进度、猜测和失败噪声不得进入。
- 深记忆不靠时间自动删除，但可以被更新记录显式 supersede。

### 4. 归档记忆

来源：旧 session、旧 daily log、旧 chat、过期 context pool。

用途：人工审计、离线报告、失败样本追溯。

默认状态：`archived`。

规则：

- 不进入模型上下文。
- 只保留最小索引：时间、来源、主题、caseId、sessionId、结论、相关文件。
- 原始内容可移动到 archive 目录或压缩存储。

### 5. 删除项

来源：重复诊断、旧错误回放、空回答、被确认错误且已有新记录替代的临时结论、超预算测试噪声。

状态：`deleted`。

规则：

- 删除前必须能说明删除原因。
- 被人工标记为保留、作为失败复盘样本、或关联 open issue 的记录不得自动删除。

## 生命周期字段

所有可管理记忆建议具备以下元数据：

```json
{
  "lifecycle": {
    "state": "awake|sleeping|archived|deleted|ephemeral",
    "importance": 0,
    "confidence": 0,
    "createdAt": "ISO timestamp",
    "updatedAt": "ISO timestamp",
    "lastAccessedAt": "ISO timestamp|null",
    "expiresAt": "ISO timestamp|null",
    "staleAfter": "ISO timestamp|null",
    "wakePatterns": [],
    "relatedFiles": [],
    "relatedCaseIds": [],
    "relatedSessionIds": [],
    "supersedes": [],
    "supersededBy": null,
    "deleteReason": null
  }
}
```

## 唤醒规则

每次用户提问先经过 `request_decision`。只有确定题型后，记忆系统才选择可用上下文。

唤醒顺序：

1. 用户手动选择的 context source。
2. 与当前 caseId / sessionId / 文件路径直接相关的记录。
3. 与 request type 匹配的深记忆。
4. 最近且高置信的浅记忆。
5. 归档记忆只返回索引，不自动注入全文。

不同题型的默认注入：

| 类型 | 默认醒着的记忆 |
| --- | --- |
| `project_listing` | 无需深记忆，直接工具执行 |
| `directory_listing` | 无需深记忆，直接工具执行 |
| `file_inspection` | Project Memory + 文件 artifact |
| `directory_inspection` | Project Memory + 目录 artifact |
| `surface_location` | Project Memory |
| `capability_status_inspection` | Project Memory + Long Tasks + Decisions，必要时读 docs/code artifact |
| `story_workflow_execute` | Long Tasks + Status + workflow/intent registry |
| `write_or_invoke_review` | Decisions + review policy |
| `contextual_plan_answer` | 最近相关对话 + selected context pool |
| `answer_only` | 最小 Project Memory 或无项目记忆 |

## 转换规则

### 变成 awake

- 人工确认的稳定规则。
- 被 workflow / evaluator / intent 使用并通过验证。
- 当前 active long task 或 active blocker。
- 与当前提问直接匹配，并且 confidence 足够高。

### 变成 sleeping

- 普通聊天结论。
- 单次测试摘要。
- 暂时有用但未人工确认的 context pool。
- 近期未被访问，但还可能有参考价值的记录。

### 变成 archived

- 旧 completed session。
- 旧 daily log。
- 已关闭任务的完整过程记录。
- 被新深记忆总结过的原始长内容。

### 变成 deleted

- 诊断类自问自答。
- 重复保存的相同 prompt/answer。
- 空结果、超时错误、模型资源错误等已被结构化事件替代的聊天噪声。
- 被确认错误且已有 correction/supersededBy 的旧结论。

## 保留窗口建议

| 类型 | 活跃窗口 | 睡眠/归档策略 |
| --- | --- | --- |
| active reasoning session | 运行期间 | 完整保留 |
| completed reasoning session | 7 天 | 摘要 + artifact 索引保留 30 天，原始大字段归档 |
| failed/cancelled session | 14 天 | 若关联 bug/proposal 则保留索引；否则归档 |
| chat history | 当日 + 最近相关 turn | 7 天后只保留摘要；诊断噪声直接删 |
| context pool | 30 天或 5 次未命中 | 降为 sleeping；90 天未访问归档 |
| daily log | 当日醒着 | 7 天后睡眠；30 天后按月归档 |
| STATUS.md | 永远当前 | 覆盖式维护，不存历史流水 |
| TASK_QUEUE.md | 只保留 active | 完成项删除或转报告 |
| DECISIONS.md | 长期醒着 | 只允许稳定决策，旧决策由 supersededBy 替代 |

## 清理执行器

建议新增 `memory_lifecycle_maintenance` 周期任务，启动时和每日最多运行一次。

执行步骤：

1. 扫描 chat、context pool、reasoning sessions、daily log、memory markdown。
2. 根据元数据和规则计算 `nextLifecycleState`。
3. 生成 maintenance report：删除、睡眠、归档、保持醒着的条目数量。
4. 只自动删除低风险噪声；其余产生待审核 proposal。
5. 更新 context source preview，让 Control Console 能显示每条记忆的状态。

## 不允许的做法

- 不允许把所有历史聊天直接注入 planner。
- 不允许把 failed answer 当深记忆。
- 不允许因为频繁出现就自动晋级为稳定规则。
- 不允许在没有 supersededBy / deleteReason 的情况下删除人工确认过的决策。
- 不允许让模型自己决定删除深记忆；模型只能提出 proposal。

## 最小落地顺序

1. 为 context pool 增加 lifecycle 元数据。
2. 为 chat history 写入轻量 retention：诊断噪声删除、重复 turn 合并、旧 turn 睡眠。
3. 为 `buildProjectMemorySystemMessage` 增加 lifecycle-aware source selection。
4. 为 reasoning sessions 增加 summary index，旧 session 不再全文参与检索。
5. 在 Control Console 展示 memory state，并允许人工 pin / sleep / archive / delete。