# GameStudio Control System

本文是 Control 系统的全面说明。生产级推进计划见 [系统生产级推进方案.md](系统生产级推进方案.md)。

## 目标

Control 系统是 GameStudio 的控制平面，负责把用户目标转成可审核、可执行、可观测、可验收的任务链。

它不是另一个聊天入口，而是任务编排系统：自然语言只负责表达目标，真正的执行必须落到 workflow、action schema、executor guard、artifact 和 deterministic evaluator。

## 模块结构

```text
apps/control-console/   # Vue + Vite 控制台前端
apps/control-server/    # Node + Hono 控制服务后端
apps/server/            # GameStudio 项目读写、编译、校验、资产和导出服务
config/hermes/          # Hermes 左脑、路由、intent、skill 配置
state/                  # runtime events、reasoning sessions、review records
storage/projects/       # 项目产物真相源
```

## 核心链路

```text
Control Console
  -> Control Server request decision
  -> workflow registry
  -> action schema / review gate
  -> Hermes / OMLX candidate generation when needed
  -> GameStudio Server API
  -> artifacts / evaluator
  -> final answer based on evidence
```

## 关键职责

| 组件 | 职责 |
| --- | --- |
| Control Console | 任务输入、审核、进度展示、生命周期控制。 |
| Control Server | 路由、计划、审核、执行、artifact、evaluator、失败边界。 |
| Hermes | 模型路由、候选生成、解释和总结。 |
| OMLX | 本地模型推理。 |
| GameStudio Server | 项目事实读写、编译、校验、资产和导出。 |

## 已具备能力摘要

- Control 与 GameStudio 可独立启动和自检。
- Hermes 已作为 `hermes-manager` 代理对象进入控制系统。
- 模型请求已有统一队列、预算和 heartbeat。
- reasoning session、agent runtime event、review record 和 artifacts 已用于可观测执行。
- story workflow 的文本故事链路已具备主要 actions/tools/evaluators。
- GameStudio bootstrap flow 已能确认服务、打开 Editor、写入本地 OMLX/ComfyUI 配置并执行自检。

## 未实现项

- 完整任务状态机和阶段机。
- 跨重启 checkpoint 恢复和 orphan session 收敛。
- 批量任务队列、暂停、取消、续跑。
- `_inbox` proposal 的自动化测试、晋级、回滚和可视化审批。
- 完整图片资产 workflow 和资源引用回填。
- 生产运维 UI 中的一键取消当前 reasoning session / production test。

## 路由规则

Control Server 收到请求后先做 request decision，再决定执行路径。

| 类型 | 用途 |
| --- | --- |
| `answer_only` | 不需要项目事实证据的普通解释。 |
| `plan_then_answer` | 需要只读工具和 artifacts 的检查任务。 |
| `inspect_then_answer` | 能力状态、覆盖度、缺口、是否完成类问题。 |
| `workflow_execute` | 创建、配置、生成、校验、导出等生产任务。 |
| `write_or_invoke_review` | 写入、删除、脚本、生命周期动作等需要审核的任务。 |

工程原则：确定性分类优先；只有规则置信度不足时才调用 Hermes 做轻量分类。命中固定 workflow 后，不允许模型自由发明 action 名。

## 安全边界

- 模型输出只能作为候选，不是事实。
- 写入、删除、导出、脚本和外部服务动作必须受 review gate 或明确测试策略约束。
- workspace 外路径必须拒绝。
- 文件/目录类型错误必须返回明确边界，如 `not_found`、`not_file`、`not_directory`。
- `_inbox` proposal 不能自动晋级为 active intent、workflow 或 evaluator。
- L2/L3/L5 事实、边界、安全和运维题不应消耗本地模型。

## 记忆与运行记录

- `state/` 保存运行态记录，用于审计和复盘，不默认作为模型事实源。
- `ai/memory/STATUS.md` 保存短期状态，不能堆历史流水。
- `ai/memory/TASK_QUEUE.md` 保存当前活跃任务。
- `ai/memory/DECISIONS.md` 只保存稳定决策。
- 模型不能自行删除或晋级深记忆，只能提出待审核 proposal。