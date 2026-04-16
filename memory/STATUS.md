# STATUS - 当前状态

## 当前目标
- 推进正式场景出图验证，确认地点/道具资产能稳定随 assetRefs 带入。

## 当前结果
- team_checkin 已落地并可执行。
- BOOT 阶段可触发团队签到。
- planner/executor/critic/reporter 四个 agent 的 main 会话已验证可见。
- Hermes 已完成本地模型接入，终端工具调用恢复正常。
- Telegram 通道已接通，可用于通知、状态查询和轻量交互。
- 每天 07:00 Telegram 日报与每 3 小时邮件汇报已配置。
- 已建立跨渠道共享记忆规则：统一以 STATUS 与每日日志作为事实源。

## 阻塞项
- 正式场景仍存在资产漂移样本，需先收集可复现案例。
- assetRefs 传递链路缺少端到端追踪记录。

## 下一步
1. 运行一轮正式场景出图验证并固化案例。
2. 记录漂移最明显场景编号、资产 id、结果差异。
3. 定位 /api/projects/:id/ai/background 到提示词组装的 assetRefs 传递点。
4. 在 Telegram 和终端各做一次“刚才做到哪”回忆测试，确认共享记忆效果稳定。
