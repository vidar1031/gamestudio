# AUTO-B03：orphan 扫描与恢复收敛

## 任务目标

Control Server 启动时识别未终结 session，将其收敛为可恢复的 `orphaned` 或不可恢复的 `blocked`，并能从 B02 checkpoint 的合法位置恢复。

## 前置依赖

- AUTO-A02、AUTO-B01、AUTO-B02 必须完成本地验收。

## 范围内

- 启动/扫描入口、orphan 判定规则和状态事件。
- 基于既有 checkpoint 的恢复资格、恢复次数和原因记录。
- 恢复 API/服务的错误语义与回归测试。

## 范围外

- 不重写 B02 checkpoint 持久化格式。
- 不实现队列调度（AUTO-C01）。
- 不修改生命周期控制语义。

## 必须满足

1. 重启或心跳过期的非终结 session 进入 `orphaned`，并记录判定原因。
2. 证据完整的 orphan 仅从 `nextStepIndex` 恢复，已成功 step 不重跑。
3. checkpoint 缺失、损坏或恢复次数超限时进入 `blocked`，不猜测继续。
4. 已终结 session 不会被扫描为 orphan。
5. 模拟重启、可恢复、不可恢复和重复恢复路径都有测试。

## 建议执行顺序

1. 读取 B01 状态机、B02 checkpoint、现有 orphan/recover 路由及相邻测试。
2. 定义可恢复与阻断的确定性判定函数。
3. 接入启动扫描和 recover 服务，记录 task/session 证据。
4. 先跑模拟重启测试，再跑受影响的控制服务测试。

## 交付证据

- orphan 判定和恢复实现。
- 重启模拟、恢复 step index、不可恢复 BLOCKED、幂等恢复测试输出。
- session 状态事件和 checkpoint 对比证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-A02, AUTO-B01, AUTO-B02