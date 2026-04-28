# STATUS - 当前状态

## 当前目标

- 完成 `control + hermes` 的记忆闭环，让 runtime 在下一轮测试中能持续读取并正确维护 `LONG_TASKS`、`STATUS`、`TASK_QUEUE`、`DECISIONS` 与当日日志。
- 继续收敛“创建故事项目 -> 配置项目 -> 生成文本与图片 -> 验证结果”的统一任务链。

## 当前结果

- control-console 的记忆记录已切回页面内 CodeMirror 编辑器。
- `LONG_TASKS.md` 已进入 Hermes runtime 注入链和 reasoning planner 默认记忆源。
- control-console 的“当日日志”记录已修正为只打开当天 `ai/memory/YYYY-MM-DD.md`。
- reasoning planner 已增加 memory sync 约束：涉及状态变化、流程修复、配置更新或多步骤推进时，会在最终回答前补 `STATUS`、`TASK_QUEUE`，并按需补 `DECISIONS` 与 `LONG_TASKS`。

## 当前阻塞

- 还缺少一次端到端实测，验证下一轮 runtime / reasoning 在人工审核通过后，是否会持续把记忆文件更新到最新状态。
- “创建故事项目”的最小输入 contract 仍需固定到可复用模板。
- editor / server / control 三层对项目生成、配置和资产回填的责任边界还需要继续固化。

## 下一步

1. 运行一次新的 control / reasoning 闭环任务，重点观察 `STATUS`、`TASK_QUEUE`、`DECISIONS`、`LONG_TASKS` 是否按预期生成待审核写回步骤并成功落盘。
2. 固化“创建故事项目”的最小输入与输出 contract。
3. 固化图片与资产生成链路在 control / hermes / server 之间的责任边界。
