# TASK_QUEUE - 短任务队列

## Ready

- [ ] 运行一次新的 control / reasoning 端到端测试，确认 memory sync 步骤会写回 `STATUS.md`
  - 验收标准: 出现待审核写入步骤；审核通过后 `STATUS.md` 时间戳和内容更新到本轮结果

- [ ] 运行一次新的 control / reasoning 端到端测试，确认 memory sync 步骤会重写 `TASK_QUEUE.md`
  - 验收标准: 旧的 2026-04-24 短任务被清理，只保留当前有效短任务

- [ ] 运行一次新的 control / reasoning 端到端测试，确认规则修复类任务会补写 `DECISIONS.md`
  - 验收标准: 稳定规则新增或修订后，`DECISIONS.md` 有对应更新且不混入流水账

- [ ] 验证 `LONG_TASKS.md` 已进入 runtime 注入链并在长线工作流修正时可被同步
  - 验收标准: planner / chat 的 memory source 中可见 `Long Tasks`，必要时能生成对应写回步骤

- [ ] 固化“创建故事项目”的最小输入 contract
  - 验收标准: 明确 project title、story brief、target style、输出目录与初始化文件集合

- [ ] 固化“项目配置”任务的最小输入 contract
  - 验收标准: 明确模型、模板、资源路径、生成选项和存储路径

## In Progress

- [ ] 收敛 control / hermes 的记忆闭环
  - 当前状态: 代码侧注入、daily log 选择、页面内编辑器和 planner memory sync 已修复，等待下一轮 runtime 实测验证落盘效果

## Blocked

- [ ] 设计端到端“创建项目 -> 配置 -> 生成图片”长任务回放题目
  - 阻塞原因: 依赖记忆闭环实测通过与前两项 contract 固化后再定义更稳定
