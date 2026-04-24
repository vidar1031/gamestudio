# DECISIONS - 生效中的项目决策

## 1. 控制平面是唯一任务入口

- 决策：`apps/control-console` + `apps/control-server` 是 Hermes 的唯一控制平面
- 原因：避免已废弃的旧协作流程继续干扰当前项目任务

## 2. 项目扫描以 storage/projects 为准

- 决策：stories / 项目扫描优先读取 `storage/projects`
- 原因：这是当前 GameStudio 的实际项目创建目录
- 兼容：仓库根 `projects/` 仅作为缺失检查与旧路径兼容

## 3. stories 扫描结果必须显式返回负结论

- 决策：未找到项目、目录缺失、scripts.json 无有效节点时，必须明确返回扫描目录、缺失目录与证据不足原因
- 原因：避免 reasoning 在失败或空结果时沉默结束

## 4. stories 类最终回答采用确定性汇总

- 决策：当 reasoning 已获得 `storyScan` 结果时，最终回答优先基于 artifacts 做确定性汇总，而不是让模型自由发挥
- 原因：防止把未扫描到的 assets / scenes / props 编造成已观测事实

## 5. 聊天与 reasoning 使用不同的历史窗口

- 决策：普通聊天使用较长的当前会话重放窗口；reasoning 使用较短窗口
- 当前值：chat = 24，reasoning = 8
- 原因：普通聊天需要短期记忆，reasoning 更需要抑制旧上下文噪声

## 6. Daily Log 只认当天文件

- 决策：只注入当天的 `ai/memory/YYYY-MM-DD.md`，没有当天文件时不注入旧日志
- 原因：避免过期日志持续污染当前任务判断
