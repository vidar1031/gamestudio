# Reasoning Plan Extension Guide

本文件用于给 control + hermes 的 plan 能力扩展提供统一参考。

目标不是继续堆硬编码 prompt，而是按下面两层扩展：

1. 用 skill 提供路由、审核和 planner action hints。
2. 用 action registry 提供真正可执行、可观测、可验证的能力。

## 管理方式

新增 skill：

1. 在 `config/hermes/skills/<skill-name>/SKILL.md` 创建新文件。
2. 在 control-console 的“技能文件清单”里加入该 `SKILL.md` 路径并保存左脑配置。
3. 在提交前勾选该 skill，planner 才会把它当作本次 plan 的规则输入。

移除 skill：

1. 先从“技能文件清单”里移除路径并保存。
2. 如不再需要，再删除对应 `SKILL.md` 文件。

修改 skill：

1. 直接编辑 `SKILL.md`。
2. 如修改了 `Planner Action Hints`，新的 plan 预览会立即反映命中的 hints。

## Skill 示例

下面是一个可以增强“control / Hermes 代码定位”和“运行时诊断”能力的 skill 示例：

```md
# Control Runtime Skill

当问题涉及 control、Hermes、runtime、日志、reasoning、调度链路时使用本 skill。

## 目标

优先回答当前 control 平面内可验证的后端事实，不要退回到仓库外的历史架构猜测。

## 路由规则

- 遇到 control / Hermes / reasoning / runtime 类问题，优先停留在 `apps/control-server/src`。
- 遇到控制台交互类问题，优先停留在 `apps/control-console/src/App.vue`。

## Planner Action Hints

- control|Hermes|reasoning|后端文件|runtime => locate_project, inspect_control_backend_surfaces, generate_default_answer
- 日志|恢复|超时|重启 => locate_project, inspect_control_backend_surfaces, generate_default_answer
```

说明：

1. 左边关键词用 `|` 分隔。
2. 右边 action 用 `,` 分隔。
3. 最后一个通常是回答 action，比如 `generate_default_answer`。
4. 前面的 action 必须已经在后端 registry 中注册，否则不会生效。

## Action 示例

下面是一个新的 observable action 注册示例，适合加入 `apps/control-server/src/index.js` 的 action registry：

```js
inspect_runtime_logs: {
  title: '检查运行时日志',
  tool: 'runtime.inspectLogs',
  category: 'observable',
  description: '读取控制面和 Hermes 运行日志，提取可验证错误与恢复线索。'
}
```

如果要真正可执行，还需要补三部分：

1. 可观测执行器：
在 `executeReasoningStep(...)` 里实现 `inspect_runtime_logs` 的实际检查逻辑。

2. 时间线说明：
在 `buildReasoningObservableOps(...)` 里补这条 action 的调用说明，方便审核时看到执行了什么。

3. 可选的确定性回答：
如果这条 action 的输出已经足够结构化，可以补一个 deterministic answer，减少模型自由发挥。

## 推荐扩展顺序

1. 先问：这个新问题是否真的需要新的 observable action？
2. 如果只是路由和约束变化，优先只改 skill。
3. 如果需要新的仓库内证据提取能力，再新增 action。
4. 新增 action 后，再给相关 skill 增加 `Planner Action Hints`。

这样做的结果是：

1. skill 负责“应该怎么规划”。
2. action 负责“到底能执行什么”。
3. control-console 负责“把命中的规则和真正发送的内容展示出来”。