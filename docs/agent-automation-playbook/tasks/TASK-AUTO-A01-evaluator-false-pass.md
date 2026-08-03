# AUTO-A01：修复 evaluator false-pass

## 任务目标

修复生产测试中 evaluator 失败仍可能被判定为 PASS 的问题，建立可信的最终放行判定。

## 当前依据

- `docs/PRODUCTION_DEFECTS.md` 的 P0-01。
- `L4-04 evaluator false-pass` 已被列为进入图片阶段前的硬阻断。

## 范围内

- reasoning quality gate 的最终判定。
- compose evaluator 失败的传播。
- 相关生产测试的失败回归。

## 范围外

- 不修改模型提示词来填充关键词。
- 不降低 evaluator 标准。
- 不修改图片资产链路。
- 不重构整个 controlServerCore。

## 必须满足

1. evaluator 明确返回失败时，最终 verdict 不能是 PASS。
2. evaluator 不可用时，结果必须是 BLOCKED 或 FAIL，并包含原因。
3. session、case、日志的结论一致。
4. 加入至少一个故意失败的自动化测试。

## 建议执行顺序

1. 读取 qualityGate、production test evaluator 和 verdict 聚合代码。
2. 找到 compose evaluator 失败后仍被覆盖为 PASS 的具体分支。
3. 做最小修复。
4. 先跑故意失败的窄测试。
5. 再跑相关 L4 回归。

## 交付证据

- 修改文件列表。
- 故意失败测试命令和输出。
- 正常通过测试命令和输出。
- 最终 verdict 示例。
- 未解决风险。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: none
- evidence:
  - 修复点：`apps/control-server/src/server/reasoning/qualityGate.js` 与 `scripts/test/lib/storyWorkflowVerdict.mjs` 中的 `inspectStoryWorkflowFailure` 已统一检查 `step.ok === false`、`evaluator.passed === false`、`evaluator` 缺失/非对象、`evaluator.passed` 非 boolean 四种失败事实。
  - `finalizeReasoningSessionWithQualityGate` 在 `disableQualityAutoRetry=true` 与 `productionTest=true` 两条路径均先调用 `inspectStoryWorkflowFailure`；存在 workflow evaluator 失败时调用 `markReasoningSessionFailed`，不再 finalize 为 completed。
  - 故意失败测试：`scripts/test/lib/storyWorkflowVerdict.test.mjs` 包含 `evaluator 失败但 step.ok=true 也必须记为失败(L4-04 false-pass 回归)`；`scripts/test/qualityGateEvaluatorFalsePass.test.mjs` 包含 `disableQualityAutoRetry=true 且 story workflow evaluator 失败时 session 应记为 failed`。
  - 回归结果：
    - `node scripts/test/lib/storyWorkflowVerdict.test.mjs`：12/12 通过。
    - `node scripts/test/qualityGateEvaluatorFalsePass.test.mjs`：2/2 通过。
  - 最终 verdict 示例：`{ verdict: 'FAIL', reason: 'story workflow failure: failedSteps=story_compile_compose:evaluator_failed' }`。
  - 未解决风险：该修复只覆盖 story workflow 步骤的 evaluator；若未来新增非 story workflow 的 evaluator 路径，需要同样显式传播失败。
