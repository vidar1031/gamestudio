# AUTO-C04：Hermes gateway 监督恢复

## 任务目标

当 Hermes gateway 异常退出时，Control 能识别原因、有限退避恢复并将不可恢复状态传播给受影响任务。

## 前置依赖

- AUTO-C01、AUTO-C02 必须完成本地验收。

## 范围内

- gateway health/exit 监测、重启退避、次数上限、事件和任务阻断传播。

## 范围外

- 不更换 gateway provider。
- 不无限重启或绕过生命周期控制。

## 必须满足

1. gateway exit 能被记录为含原因、时间和受影响 task 的事件。
2. 可恢复退出按有限退避尝试恢复，重启次数可观测。
3. 达到上限或不可恢复原因进入 `blocked`/`failed`，不无限循环。
4. 恢复成功后仅恢复合法、未取消的等待任务。
5. 模拟 exit、恢复成功、达到上限和任务状态传播都有测试。

## 交付证据

- 监督器实现、配置和事件记录。
- gateway exit 模拟与退避/上限测试输出。
- 受影响 task 的最终状态证据。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02
- completed_at: 2026-08-15T06:10:00.000Z

## 交付报告

### 实现概览

新增 `apps/control-server/src/server/reasoning/gatewaySupervision.js`（注入式，与 G02 不同关注点）：
- **监测**：轮询 pid 进程状态（`HERMES_GATEWAY_SUPERVISION_POLL_MS` 默认 5s），以初始观测为基线，只在 running→down 跳变时判 exit；默认关闭（`HERMES_GATEWAY_SUPERVISION_ENABLED=true` 启用），与 G02 一致的安全默认。
- **exit 事件**：确定性分类 manual_lifecycle > unrecoverable_auth（复用 G02 `isAuthFailureError`，core 接线显式注入同一实现）> unrecoverable_config > recoverable_crash；事件含 category/reason/时间/pid/受影响 task 列表，经 `onEvent` sink 落 `state/hermes-gateway-supervision/events.jsonl` + 结构化日志（U-09 类退出可追溯）。
- **有限退避重启**：指数退避（`HERMES_GATEWAY_RESTART_BASE_MS` 默认 2s / `HERMES_GATEWAY_RESTART_MAX_DELAY_MS` 默认 30s），上限 `HERMES_GATEWAY_RESTART_MAX_ATTEMPTS` 默认 3；次数经 `getGatewaySupervisionState()`（status/restartAttempts/maxAttempts/recentEvents）与 `/api/control/supervision/state` 的 `gatewaySupervision` 字段可观测；持续健康超 `HERMES_GATEWAY_HEALTHY_RESET_MS`（默认 5min）后次数归零。
- **任务传播（复用阶段 2 设施，不新造恢复通道）**：可恢复退出时受影响 running/pausing/resuming session 标 failed（错误文本 `hermes_gateway_exit:...:gateway service unavailable` 命中 C02 retryPolicy 临时故障模式，测试用真 `classifyReasoningFailure` 验证=retryable），由队列 worker 调度 retry_wait 退避重试；达上限或不可恢复时受影响任务（含本故障窗口被标 failed 的，避免卡在非终态 failed）经状态机收敛 `blocked` 终态，queue item 由 worker tick 镜像终结，不无限循环。
- **恢复成功**：不主动改任务状态——retry_wait 到点经 `canExecute`（runtime running）恢复可领取；`selectGatewayRestorableWaitingTasks` 纯函数仅挑选 retry_wait/queued + 非终态 queue item 的合法等待任务写入 `gateway_recovered` 事件并 kick 队列，已 cancelled/终态绝不动。
- **生命周期硬边界**：`hermesStoppingIntentionally` 标记（此前只写不读，本任务启用并在 `startHermesRuntime` 成功启动后复位）；stop/pause/exit/all-restart 发起的关停只记 manual_lifecycle 事件，绝不自动拉起、绝不传播任务状态；blocked 后人工 resume 恢复健康时监督器自动回到 monitoring。
- **既有 health-check 协调**：监督器启用时，`ensureHermesHealthCheck` 的「pid 消失直接拉起」委托给监督器，避免双通道竞争与无上限重启；关闭时既有行为完全不变。

### 修改文件

- 新增 `apps/control-server/src/server/reasoning/gatewaySupervision.js`（监督器 + 分类/退避/恢复资格纯函数）
- 新增 `scripts/test/gatewaySupervision.test.mjs`（13 例）
- `apps/control-server/src/server/controlServerCore.js`：AUTO-C04 接线段（probe/restart/affected 扫描/`blockReasoningSessionByGateway`/事件 JSONL sink/单例与启停/状态查询）；`startHermesRuntime` 复位 `hermesStoppingIntentionally`；`ensureHermesHealthCheck` 启用监督时委托恢复；路由 context 暴露 `getGatewaySupervisionState`
- `apps/control-server/src/server/routes/overviewRoutes.js`：`/api/control/supervision/state` 响应新增 `gatewaySupervision` 字段
- `apps/control-server/src/index.js`：启动序列挂 `startGatewaySupervision()`（默认关闭时不启动轮询）
- `ai/control_architecture.md`：同步 AUTO-C04 段

### 测试与验证

- `node --test scripts/test/gatewaySupervision.test.mjs`：**13/13 通过**。
  - 纯函数：四类 exit 分类（503 不误判 auth）、指数退避封顶、恢复资格挑选（cancelled/终态 item 排除）、受影响状态集合。
  - S3-04 模拟 exit：事件含 category/reason/at/pid/受影响 task；running session 标 failed 且经真 retryPolicy 分类=retryable；retry_wait/终态不动；退避调度次数可观测。
  - S3-04 恢复成功：`gateway_recovered` 事件 restoredTasks 仅含合法未取消等待任务；kickQueue 被调用；次数可观测。
  - S3-04 达上限：maxAttempts=2 恰好重启 2 次后 blocked，等 60ms 确认不再重启（不无限循环）；running+retry_wait 均经真状态机收敛 blocked；事件含受影响 task。
  - S3-04 不可恢复：restart 失败 detail 含 401 → 仅 1 次尝试即 `gateway_unrecoverable` + blocked 传播。
  - 硬边界：intentional 关停 manual 事件、0 次重启、0 传播；启动基线不误判；健康窗口次数归零；disabled 不轮询；blocked 后人工 resume 回 monitoring。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` **155/155 通过**（基线 142 + 新增 13，duration ~5.3s）。
- `node --check`：`apps/control-server/src/index.js`、`controlServerCore.js`、`overviewRoutes.js`、`apps/server/src/index.js`、`gatewaySupervision.js` 全部通过。
- 冒烟：`sh restart_control.sh` 重启通过；`/api/health` ok；`/api/control/supervision/state` 返回 `gatewaySupervision`（enabled=false/status=disabled，默认关闭语义正确）；control-server 日志无 gateway-supervision 异常。
- 未动 control-console（无 typecheck 需求）；生命周期控制（start/stop/pause/resume/exit/all-restart）语义未动。

### 事件样例（测试产物）

```json
{"type":"gateway_exit","at":"...","restartAttempts":0,"pid":4242,"category":"recoverable_crash","reason":"gateway_unexpected_exit","affectedTasks":[{"sessionId":"s_running","status":"running"},{"sessionId":"s_retry","status":"retry_wait"}]}
{"type":"gateway_restart_scheduled","attempt":1,"maxAttempts":3,"backoffMs":5}
{"type":"gateway_recovered","attempt":1,"restoredTasks":[{"sessionId":"s_retry","status":"retry_wait","taskId":"t_retry","projectId":"p1"}]}
{"type":"gateway_restart_exhausted","reason":"gateway_restart_exhausted:attempts=2/2","affectedTasks":[...]}
{"type":"gateway_exit","category":"manual_lifecycle","reason":"manual_lifecycle_stop","affectedTasks":[...]}
```

### Acceptance 自检矩阵

| acceptance | test_or_assertion | result |
| --- | --- | --- |
| exit 记录含原因/时间/受影响 task 的事件 | `gateway_exit` 事件断言（category/reason/at/pid/affectedTasks） | pass |
| 可恢复退出有限退避恢复、次数可观测 | `gateway_restart_scheduled`/`gateway_recovered` + getState restartAttempts/maxAttempts | pass |
| 达上限/不可恢复进 blocked/failed，不无限循环 | exhausted（恰好 2 次后不再重启）+ unrecoverable_auth（1 次即收敛），任务经真状态机 blocked | pass |
| 恢复成功仅恢复合法未取消等待任务 | restoredTasks 仅 retry_wait/queued + 非终态 item；cancelled 排除；纯函数反向用例 | pass |
| 模拟 exit/恢复成功/达上限/任务传播有测试 | gatewaySupervision.test.mjs 13 例 | pass |
| 生命周期控制不被监督器拉起 | manual_lifecycle 用例（0 重启 0 传播） | pass |

### 取舍

- 恢复成功采用「被动恢复」（队列 canExecute 到点领取 + kick），不新造恢复通道——复用 C01/C02 既有调度语义，cancelled/终态天然不可能被领取。
- 达上限/不可恢复的传播目标包含本故障窗口被监督器标 failed 的 session（failed→blocked 合法转移），避免其卡在非终态 failed 无人收敛；无关原因 failed 的 session 不触碰。
- 退避/上限参数独立解析（与 C02 retryPolicy 同语义不同 env），避免任务级重试与进程级重启两个关注点互相漂移。
- 默认关闭：启用前既有 health-check 直接拉起行为不变；启用后单通道有限恢复。

### 风险

- core 接线段（probe/restart/blockSession/事件落盘）受 core 写死真实 state/ 目录限制无法 import 单测，采用注入式原语测试 + 启动冒烟覆盖（与阶段 2 同一残余风险，靠 review）。
- 真实 gateway 崩溃→恢复的全链路（含真实 pid 监测与 ComfyUI/OMLX 联动）未做端到端演练，需 Hermes gateway 运行时验证；建议随 D01 console 展示一起做真实联调。
- 监督器启用且 gateway 长期 down 时，retry_wait 任务在 blocked 传播前会一直处于等待（由 canExecute 门禁挡住领取），直到达上限收敛 blocked——这是设计内的延迟收敛，非泄漏。