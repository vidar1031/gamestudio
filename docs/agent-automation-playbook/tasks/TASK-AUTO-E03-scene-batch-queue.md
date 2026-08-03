# AUTO-E03：批量场景生产队列

## 任务目标

让多个 scene 按受控顺序生成，单 scene 失败可重试，成功结果不被重复覆盖。

## 前置依赖

- AUTO-C01、AUTO-C02、AUTO-E02 必须完成本地验收。

## 范围内

- scene item 入队、串行/并发约束、per-scene checkpoint、重试和结果保护。

## 范围外

- 不覆盖已有通过评审的成功资产。
- 不绕过 reference gate。

## 必须满足

1. 至少 3 个 scene 可被提交并以可观测顺序执行。
2. 单 scene 失败不阻塞其他合法 scene，失败 scene 可按 C02 策略恢复。
3. 已成功 scene 不重复生成或覆盖，除非存在显式重新生成意图。
4. 重启后从正确 scene/checkpoint 继续。
5. 三 scene、单失败恢复、成功保护和重启恢复均有测试。

## 交付证据

- batch queue 实现与三 scene 测试输出。
- per-scene task/checkpoint、失败重试、成功保护证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02, AUTO-E02