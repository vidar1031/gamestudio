# 多 Agent 协作协议

## 1. 协议目标

让不同 Agent 与不同模型在同一任务上共享一致上下文，减少歧义与重复劳动。

## 2. 统一消息头（建议）

```yaml
protocol_version: 1.0
task_id: TASK-YYYYMMDD-XXX
sender: orchestrator-agent
receiver: executor-agent
timestamp: 2026-07-30T00:00:00Z
intent: execute_step
```

## 3. 统一消息体（建议）

```yaml
objective: 完成某项可验证动作
inputs:
  - 文件路径
  - 接口地址
constraints:
  - 不得越权写入
  - 必须保留生命周期控制语义
expected_output:
  - 变更摘要
  - 测试结果
  - 证据列表
```

## 4. 统一响应格式

```yaml
status: success | failed | blocked
summary: 一句话结果
artifacts:
  - path: xxx
  - log: xxx
next_action: 下一步建议
```

## 5. 协作规则

- 先确认 task_id 与 objective，再执行。
- 不符合 constraints 的请求必须拒绝并回报。
- 响应必须包含 artifacts，禁止“口头完成”。
- 任何跨模块变更都要显式列出影响面。
