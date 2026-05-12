# GameStudio 任务队列

- 最新: 2026-05-11 已实现并验证 Control story workflow 文本闭环：L4 优先批 PASS=9，导出产物存在。
- 已完成: L4 deterministic request-decision、artifact final answer、L4-08 最小 scripts fallback、非模型必答 story workflow runtime-bypass 窄口径保护。
- 待办: 跑完整 L1 批次，确认全部模型必答样本都有 Hermes/OMLX evidence。
- 待办: 跑 L5 边界测试，覆盖异常恢复、未审核写入、未白名单脚本和越权拒绝。
- 待办: 图片 provider 稳定后推进资产生成与资源引用校验。
- 待办: 持续观察 Hermes gateway / OMLX connection fault 对模型必答链路的影响。
