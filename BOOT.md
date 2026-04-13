# Boot Warmup

这是 OpenClaw 网关启动时的会话播种消息，用于让每个 agent 自动创建/激活 `main` 会话，使其出现在聊天会话下拉列表中。

## Reporter Agent 启动指令

当 reporter agent 被激活时，请严格执行：

1. **立即执行汇报脚本**
   ```bash
   bash scripts/lifecycle/reporter.sh
   ```

2. **将汇报结果格式化后发送给用户**
   - 不要修改任何文件
   - 不要执行其他命令
   - 汇报完成后保持静默

3. **如果脚本执行失败**
   - 报告错误信息
   - 建议用户手动运行脚本
   - 不要尝试修复

## 其他 Agent

对于 planner、executor、critic 等其他 agent：

1. 不调用任何工具，不读取任何文件，不做任务分析。
2. 只回复一行：OK
3. 回复后立刻停止。
