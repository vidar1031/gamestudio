# 子 Agent 执行任务清单

> 项目经理使用本文发起 execution campaign。每个任务应复制到 `tasks/` 下形成独立任务单。主执行 Agent 在通过任务内验收后自动推进已解锁的后续任务；campaign 结束后由主控 Agent 统一复核，不以子 Agent 自报 PASS 为最终结论。

## 使用规则

- 一次只实施一个 task，但在同一 campaign 内完成任务内验收后可自动领取满足依赖的下一个 task。
- 先读任务涉及的代码和契约，再编辑。
- 不修改任务范围外文件。
- 每个 task 必须记录变更文件、测试命令、测试输出摘要、剩余风险；campaign 结束时汇总为一份统一交付包。
- 发现前置依赖未完成时，状态改为 BLOCKED，不绕过依赖。
- task 的本地验收失败时，先在该 task 内修复；不得为等待人工确认而停下 campaign。
- 仅在外部依赖、环境、需求冲突、安全风险或三次修复仍无法通过同一验收时，暂停 campaign 并报告明确恢复条件。

## 阶段 A：放行正确性

### AUTO-A01：修复 evaluator false-pass

- 目标：任何 evaluator 失败不得进入 PASS。
- 主要范围：`apps/control-server/src/server/reasoning/qualityGate.js`、相关 production test evaluator。
- 输入证据：P0-01、L4-04 失败样例。
- 必须实现：明确区分 evaluator passed、evaluator failed、evaluator unavailable。
- 验收：故意让 compose evaluator 返回失败，最终 verdict 必须为 FAIL 或 BLOCKED。
- 禁止：通过增加关键词、修改测试期望或隐藏错误来“修复”。

### AUTO-A02：统一 verdict 与 artifacts

- 目标：session、step、production case 使用统一的 PASS/FAIL/BLOCKED/CANCELLED 语义。
- 主要范围：reasoning session 记录、quality gate、production test。
- 验收：同一失败在 session、日志、测试报告中结论一致。

## 阶段 B：状态机与恢复

### AUTO-B01：定义任务状态机与合法转移

- 目标：消除 `other` 和隐式状态。
- 建议状态：queued、running、waiting_review、pausing、paused、resuming、retry_wait、completed、failed、blocked、cancelled、orphaned。
- 必须实现：状态转移函数、非法转移拒绝、转移事件记录。
- 验收：为每个合法转移写测试；非法跳转返回明确错误。

### AUTO-B02：实现 step checkpoint

- 目标：每个成功 step 可恢复。
- 必须保存：task/session id、step id、step index、输入摘要、结果摘要、artifacts、startedAt、completedAt、nextStepIndex。
- 验收：进程中断后重新读取 checkpoint，已完成 step 不重复执行。

### AUTO-B03：实现 orphan 扫描与 recover

- 目标：服务重启后自动识别未收敛任务，并给出可恢复/不可恢复原因。
- 验收：模拟重启，session 进入 orphaned；恢复后从正确 step 继续；不可恢复任务进入 BLOCKED。

### AUTO-B04：长任务、超时和取消

- 目标：所有任务最终收敛，不允许无限悬挂。
- 必须实现：任务硬超时、step 超时、cancel 信号、超时事件。
- 验收：模拟卡住的模型调用，任务在上限内变为 timeout/failed，不占用队列。

## 阶段 C：队列与守护

### AUTO-C01：最小任务队列

- 目标：支持 queued -> running -> terminal 的持久化调度。
- 约束：同一 projectId 默认串行；全局并发数可配置；队列重启可恢复。
- 验收：提交 3 个任务，顺序和互斥符合配置；一个失败不阻塞后两个任务。

### AUTO-C02：重试与错误分类

- 目标：区分 retryable、non_retryable、needs_review、blocked。
- 验收：网络/503 退避重试；schema/业务错误不盲重试；达到上限后进入 failed。

### AUTO-C03：缓存、session、日志清理

- 目标：长期运行不因文件和 Map 无限增长。
- 范围：sessionCallCounts、inspectModelAccessCache、reasoning sessions、chat history。
- 验收：TTL/保留策略有测试；清理不删除活跃任务和未归档证据。

### AUTO-C04：Hermes gateway 监督恢复

- 目标：gateway 异常退出时，Control 能识别、记录、按退避策略恢复或阻断。
- 验收：模拟 gateway exit，日志有原因、重启次数、最终状态；超过上限不无限重启。

## 阶段 D：运维与安全

### AUTO-D01：Control Console 任务运维入口

- 目标：查看队列与任务详情，取消、恢复、重试、查看证据。
- 约束：保留现有生命周期按钮，新增功能不得隐藏 start/stop/pause/resume/exit。
- 验收：UI 每个动作都显示成功、失败、阻断原因；刷新后状态一致。

### AUTO-D02：API 访问边界

- 目标：Control API 不再无条件暴露高风险动作。
- 验收：无凭证请求被拒绝；localhost 开发模式有明确配置；日志不打印密钥。

## 阶段 E：P1 图片链路

### AUTO-E01：Character asset pipeline

- 目标：角色资产不再直接失败，能生成、评审、持久化引用。
- 验收：至少一个角色完成锁定图，primaryReferenceAssetUri 真实存在。

### AUTO-E02：锁定资产到场景渲染闭环

- 目标：严格先锁定，再渲染，再回填，再校验和导出。
- 验收：缺参考图必阻断；有参考图能生成场景图并通过 validate/export。

### AUTO-E03：批量场景队列

- 目标：多个 scene 串行生成、单场景失败可重试、不重复覆盖成功结果。
- 验收：至少 3 个场景测试，失败一个后可从该 scene 继续。

## 阶段 F：多项目和规则治理

### AUTO-F01：多项目隔离和配额

- 目标：不同项目的文件、队列、模型资源和证据互不污染。
- 验收：并发或交替任务中 projectId、artifacts、日志全部对应正确。

### AUTO-F02：proposal 测试、审核、晋级、回滚

- 目标：`_inbox` proposal 不能自动改变生产规则。
- 验收：proposal 经过测试和人工审核才可激活；激活失败可回滚；旧规则仍有版本记录。

## 子 Agent 领取格式

```yaml
task_id: AUTO-XXX
title: 
owner_agent: 
reviewer: project-manager-agent
scope_in: []
scope_out: []
preconditions: []
acceptance_tests: []
status: queued
```
