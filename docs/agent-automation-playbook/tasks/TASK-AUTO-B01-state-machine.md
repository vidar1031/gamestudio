# AUTO-B01：任务状态机与合法转移

## 任务目标

把 reasoning session 从隐式状态升级为可持久化、可验证的任务状态机，消除 `other` 和非法跳转。

## 前置依赖

- AUTO-A02 必须通过。

## 范围内

- 状态枚举和转移规则。
- 转移事件记录。
- 非法转移拒绝。
- 现有 session 状态的兼容映射。

## 建议状态

`queued -> running -> waiting_review -> running -> completed`

异常状态：

`paused`, `retry_wait`, `failed`, `blocked`, `cancelled`, `orphaned`, `timeout`

## 范围外

- 不实现完整多项目队列。
- 不修改 Control Console 视觉布局。
- 不改变 start/stop/pause/resume/exit 生命周期 API 语义。

## 必须满足

1. 每个状态都有定义和终态/可恢复性说明。
2. 非法转移返回明确错误，不静默修正。
3. 每次转移写入 task_id/session_id、from、to、reason、timestamp。
4. 重启后状态可被识别为 orphaned 或 terminal，不出现未知状态。

## 交付证据

- 状态机实现和测试。
- 合法/非法转移测试结果。
- 旧 session 兼容说明。
- 风险和后续依赖。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by:
