# 阶段 2 交付包：可恢复执行引擎

> 依据 `12-自动生产系统总实施与测试计划.md` 第 10 节编写。
> 交付日期：2026-08-15。执行：kimi-code。复核：project-manager-agent（阶段门）。

## 1. 任务完成清单

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| AUTO-B01 状态机与合法转移 | completed（此前阶段完成） | `scripts/test/sessionStateMachine.test.mjs` |
| AUTO-B02 step checkpoint | completed（此前阶段完成） | `scripts/test/stepCheckpoint.test.mjs` |
| AUTO-B03 orphan 扫描与 recover | completed（本次） | `docs/agent-automation-playbook/tasks/TASK-AUTO-B03-orphan-recover.md` |
| AUTO-B04 超时、取消与资源收敛 | completed（本次） | `docs/agent-automation-playbook/tasks/TASK-AUTO-B04-timeout-cancel.md` |
| AUTO-C01 最小持久化任务队列 | completed（本次） | `docs/agent-automation-playbook/tasks/TASK-AUTO-C01-persistent-queue.md` |

未完成：无。

## 2. 必测用例结果索引

统一验证命令：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs`
当前结果：**111/111 通过**（2026-08-15 复跑确认，duration ~5.1s）。

| 用例 | 覆盖位置 | 结果 |
| --- | --- | --- |
| S2-01 合法转移生成事件 | `sessionStateMachine.test.mjs`（20 例） | PASS |
| S2-02 非法转移明确拒绝 | `sessionStateMachine.test.mjs` | PASS |
| S2-03 成功 step 写 checkpoint | `stepCheckpoint.test.mjs`（10 例） | PASS |
| S2-04 重启 → orphaned → 从 N+1 恢复、已成功 step 不重跑 | `orphanRecovery.test.mjs`（30 例）、`persistentQueue.test.mjs`（resumeFromStep=1） | PASS |
| S2-05 checkpoint 缺失/损坏/证据不全 → BLOCKED | `orphanRecovery.test.mjs`（缺失/JSON 损坏/结构非法/超限全路径） | PASS |
| S2-06 卡住调用 → deadline 内 timeout/failed，释放 timer/锁 | `taskDeadline.test.mjs`（27 例，25ms 卡死模拟、无遗留 timer/registry） | PASS |
| S2-07 取消 queued/running/terminal + 重复取消幂等 | `taskDeadline.test.mjs` | PASS |
| S2-08 三任务：同 projectId 串行、跨 project 全局并发上限 | `persistentQueue.test.mjs`（11 例，t2.start>=t1.end、并发窗口重叠证据） | PASS |
| S2-09 单任务失败不阻塞独立后续任务 | `persistentQueue.test.mjs` | PASS |
| S2-10 重启后未终结 item 不重复领取、恢复调度 | `persistentQueue.test.mjs`（claimGeneration 1→2、各领取恰好一次） | PASS |

补充真实服务验证：`sh restart_control.sh` 启动冒烟通过（`/api/health` 正常、日志无 queue/error 异常，worker 空转不创建多余目录）。

真实模型链路的端到端演练（提交真实任务 → checkpoint → 重启 → orphaned → recover → 终态 verdict）未自动执行——需要 OMLX 运行且完整跑一个生产任务。手工复现步骤：
1. `sh restart_control.sh` 启动 control；确认 OMLX 健康。
2. 守护台提交一个真实 P0 故事任务（auto 模式），观察 `state/reasoning-checkpoints/` 出现逐步 checkpoint。
3. 任务运行中 `kill` control-server 进程；重启。
4. 预期：队列恢复日志 + session 收敛为 `orphaned`；调 recover API 或守护台恢复按钮。
5. 预期：从最新 checkpoint 的 `nextStepIndex` 继续，已完成 step 不重跑，最终收敛终态 verdict。

## 3. 修改文件与设计决定

### 新增模块（`apps/control-server/src/server/reasoning/`）

- `orphanRecovery.js`（B03）：orphan 判定、恢复资格评估、扫描收敛编排（注入式，与持久化解耦）。
- `taskDeadline.js`（B04）：task/step deadline、取消信号 registry、raceStepExecution、终结收敛。
- `persistentQueue.js`（C01）：队列 item 持久化（tmp+rename 原子写）、原子领取（workerId + claimGeneration）、FIFO 调度纯函数、启动恢复、worker 三段 tick（reconcile/镜像/领取 + 心跳扫描）。

### 修改

- `controlServerCore.js`：启动扫描改状态机收敛；`markReasoningSessionTimeout`、`cancelReasoningSession` 增强；队列 glue（dispatch/execute/worker 单例）。
- `routes/reasoningRoutes.js`：recover 路由仅接受 `orphaned` + checkpoint 资格；创建路径改 `dispatchReasoningSession` 入队（API 形状不变）。
- `sessionStateMachine.js`：补 `queued→orphaned`、`pausing→orphaned`。
- `index.js`：启动序列挂 `startReasoningQueueWorker()`。
- `control-console/SessionsPage.vue`：恢复按钮条件 `failed→orphaned`；取消按钮排除终态。

### 关键设计决定（详见各任务单）

1. orphan 语义只覆盖"被进程中断"；`failed` 保留独立 retry 路径，不互转。
2. 旧 `failed + 'orphaned by server restart'` 恢复语义废弃，由 `orphaned` 状态替代（见第 5 节反向搜索）。
3. 最新 checkpoint 损坏不回退旧 checkpoint——无法证明其间 step 未成功，直接 blocked，不猜测。
4. task deadline = 执行预算窗口，人工审核等待不计入；TIMEOUT/CANCELLED 为终态；failed 不接受 cancel（幂等返回）。
5. 队列只调度，执行链零改动复用（B02/B04 原语全保留）；waiting_review 释放 project 槽位防死锁；手动 recover 不入队（人工优先）。
6. 默认全局并发 2（本地模型承载有限）；恢复次数上限 `HERMES_REASONING_MAX_RECOVERY_COUNT=3`。

### 兼容性

- 对外 API 形状不变（创建、取消、恢复、审核路由签名均保持）；前端仅按钮显示条件跟随新状态语义。
- 历史遗留 `failed` session 保持原样，不被新扫描触碰。
- 生命周期控制（start/stop/pause/resume/exit/all-restart）语义未动。

## 4. 已知风险与下一阶段前置条件

### 风险

- core glue（dispatch/execute/recover 接线）受 core 写死真实 state/ 目录限制无法 import 单测，采用注入式原语测试 + 路由 harness + 启动冒烟覆盖，残余接线风险靠 review。
- 被遗弃 step 若完全不响应 abort，其后台 continuation 到首个状态写入点才被终态守卫拦停；signal 全程透传留待后续任务。
- `runAllReasoningStepsFrom` 的 `effectiveStartIndex` 未被循环消费（B02 既有行为）：orphan 恢复路径传入值恒等于 checkpoint.nextStepIndex 不受影响；重规划路径直接消费会跳过新计划前序步骤，安全修复需 checkpoint↔plan 一致性校验，留待后续。
- 队列 item 终结后留作证据，清理归 AUTO-C03。

### 阶段 3 前置条件

- 代码前置全部满足（B01-C01 completed，111/111 绿）。
- 外部依赖：C04（gateway 监督恢复）与 H02（cron 生产）真实验收需要 Hermes gateway 运行；S3-09（cron 真实 P0）需要 OMLX 健康。
- meta_analysis 的 Kimi key 交付时判断失效（401）；2026-08-15 复测确认 key 有效（Kimi For Coding 平台 api.kimi.com/coding/v1，401 系误测 api.moonshot.cn），右脑/meta_analysis 链路已恢复。

## 5. 反向搜索

声明移除的旧语义：`failed + orphaned by server restart` 作为恢复准入与启动直标 failed 的语义。

```bash
grep -rn "orphaned by server restart" apps/control-server/src
```

结果：仅剩 2 处注释（`orphanRecovery.js:9`、`reasoningRoutes.js:292`），内容为"旧语义已由 orphaned 状态替代"的说明，无任何活代码依赖。recover 路由对 `failed` 状态返回 409（有测试覆盖）。
