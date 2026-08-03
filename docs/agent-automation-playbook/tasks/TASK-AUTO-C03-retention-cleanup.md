# AUTO-C03：缓存、session 与日志保留清理

## 任务目标

为长期运行建立可配置的 TTL/保留策略，避免缓存、session 文件和 chat history 无限增长，同时保留活跃任务与审计证据。

## 前置依赖

- AUTO-C01、AUTO-C02 必须完成本地验收。

## 范围内

- sessionCallCounts、inspectModelAccessCache、reasoning sessions、chat history 的清理服务。
- TTL、归档/删除规则、dry-run/统计和测试。

## 范围外

- 不删除活跃队列、未终结 session 或未归档 evidence。
- 不修改项目产物保留规则。

## 必须满足

1. 每类数据有明确 TTL 或保留上限及默认安全值。
2. 清理只处理满足条件的终结/已归档记录。
3. 活跃 task、checkpoint、pending review 和未归档证据绝不被删除。
4. 清理有可追溯报告，支持 dry-run 或等价预览。
5. 过期删除、活跃保护、归档保护和重复运行幂等都有测试。

## 交付证据

- 保留策略配置与清理实现。
- dry-run/执行报告、TTL 和保护路径测试输出。
- 不删除活跃任务的反向证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02