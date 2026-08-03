# HERMES-G04：清理 story_scripts_candidate 死路由

## 任务目标

移除或修正 `story_scripts_candidate` 的死路由/配置残留，使路由声明、运行时实际调用和生产文档一致。

## 范围内

- 路由配置、调用点、测试与必要文档事实更新。

## 范围外

- 不重写真实脚本生成 API。
- 不把 direct 模型调用伪装成 Hermes strict 路由。

## 必须满足

1. 不存在可被选中但必然失败/从未消费的 `story_scripts_candidate` 路由条目。
2. 当前脚本生成的实际 provider/transport 在配置、日志和文档中一致。
3. 对无效路由的请求返回明确错误或不可选，不静默降级。
4. 相关路由测试和 production 语法/类型检查通过。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by:
