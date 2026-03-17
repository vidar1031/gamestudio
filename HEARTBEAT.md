# HEARTBEAT.md

仅在真正的 heartbeat 或 cron 轮询中使用本文件；人类在 WebChat、Telegram、WhatsApp 等聊天窗口发来的消息一律忽略本文件。

如果当前消息来自真实用户聊天：

- 不要把它当成 heartbeat。
- 不要输出 `HEARTBEAT_OK`。
- 直接按用户请求完成任务并正常汇报结果。

只有在自动轮询会话里，才处理下面这些任务；不要推断其他旧任务。

1. 读取 `memory/TASK_QUEUE.md`、`memory/STATUS.md` 和最近一天的 `memory/YYYY-MM-DD.md`，确认当前目标是否仍然围绕“H5 交互小故事主链路”。
2. 优先判断主链路哪个环节最阻塞：故事创建、蓝图编译、连续性约束、场景图生成、合成导出、测试验收。
3. 如果当前轮询是维护型任务，才运行 `npm run typecheck`；若失败，只记录高价值错误摘要，不做大规模猜测。
4. 如果项目状态文件缺少关键信息，补写：
   - 当前目标
   - 最新阻塞项
   - 下一步动作
5. 如果发现 `PROJECT_PLAN.md` 与 `memory/STATUS.md` 明显不一致，整理差异并以 `memory/STATUS.md` 为短期状态源补齐。
6. 如果本轮是推进型任务，选择一个最小可闭环的生产任务推进，不要只做泛化巡检。
7. 如果没有新问题、没有新进展、没有状态漂移，回复 `HEARTBEAT_OK`。
