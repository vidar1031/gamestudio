# AUTO-A02：统一 verdict 与 artifacts

## 任务目标

统一 session、step、production case 的 PASS/FAIL/BLOCKED/CANCELLED 语义，确保同一失败在 session 记录、quality gate、production test 报告中的结论一致。

## 当前依据

- `docs/agent-automation-playbook/07-子Agent执行任务清单.md` 的 AUTO-A02 描述。
- AUTO-A01 已修复 evaluator false-pass，session 状态已能正确传播到 `failed`。

## 范围内

- reasoning session 记录中的 verdict/status 语义。
- quality gate 的 `passed` / `selfReview.verdict` / `assessment`。
- production test 脚本的 case verdict 生成与消费。
- story workflow step 结果中的 `ok` / `evaluator.passed` / `failedStage`。

## 范围外

- 不修改模型提示词。
- 不降低 evaluator 标准。
- 不修改图片资产链路。
- 不实现完整任务状态机（状态机是 AUTO-B01）。
- 不实现 checkpoint / orphan recover（那是 AUTO-B02/B03）。

## 必须满足

1. session、step、case 都使用统一的 `PASS/FAIL/BLOCKED/CANCELLED` 语义表达最终结果。
2. 失败路径在 session 记录、quality gate 事件、production test 报告中结论一致。
3. 取消路径（`cancelled`）在三种载体中结论一致。
4. 成功路径不变，仍统一表达为通过。
5. 补齐四类回归测试：失败、取消、成功、completed 但 final answer 缺失。
6. 对 `control_production_test.mjs` 执行静态断言：不得再出现 `SOFT PASS` 或 `soft-passed`。

## 强制映射矩阵

本任务不得保留 `SOFT PASS`、`soft-passed` 或任何第五种最终 verdict。它们不得出现在 case 结果、汇总、人工判定菜单或统一 verdict 常量中。

| 可观测事实 | 最终 verdict | 必须包含的 reason/evidence |
| --- | --- | --- |
| `session.status === 'cancelled'` | `CANCELLED` | 取消来源或 session error |
| `session.status === 'waiting_review'` | `BLOCKED` | 当前 review 标识或等待原因 |
| workflow step `ok === false` | `FAIL` | `stepId/action` 与 `failedStage` |
| evaluator 缺失、不可用或 `passed` 非 boolean | `FAIL` | `evaluator_unavailable` 或 `evaluator_indeterminate` |
| evaluator `passed === false` | `FAIL` | `evaluator_failed` 与 evaluator 证据 |
| `session.status === 'failed'` | `FAIL` | session error |
| `session.status === 'completed'` 且 final answer 非空、无失败证据 | `PASS` | final answer/artifacts 引用 |
| `session.status === 'completed'` 但 final answer 为空 | `FAIL` | `final_answer_missing` |
| 未知或无法解释的 session 状态 | `BLOCKED` | 原始状态值 |

`completed + 空 final answer` 不是“弱通过”。任务已终结但没有可交付回答，属于可确定的失败；未知状态才是 `BLOCKED`。

## 建议执行顺序

1. 读取 qualityGate.js、control_production_test.mjs、storyWorkflowVerdict.mjs 和 controlServerCore.js 中相关 verdict/status 使用点。
2. 定义统一的 verdict 常量或映射函数。
3. 在 quality gate 最终判定、session 事件、production test 报告中使用统一语义。
4. 跑失败/取消/成功三类回归测试。
5. 跑 completed 但 final answer 缺失的回归测试，并执行禁止旧 verdict 的静态断言。
6. 若任一映射、测试、静态断言未满足，在同一个 AUTO-A02 内继续修复和验证；不得将其作为“已完成但遗留风险”提交。

## 交付证据

- 修改文件列表。
- 统一后的 verdict 映射代码。
- 四类回归测试命令和输出。
- `rg -n "SOFT PASS|soft-passed" scripts/test/control_production_test.mjs scripts/test/lib/storyWorkflowVerdict.mjs` 的空结果证据。
- 未解决风险。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by:
