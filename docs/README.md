# GameStudio Docs

本文是 `docs/` 的唯一入口。这里不保存历史测试结果、实施流水、过期状态和重复设计稿，只保留系统全面说明与全新工作任务流说明。

## 当前文档

| 文档 | 用途 |
| --- | --- |
| [系统生产级推进方案.md](系统生产级推进方案.md) | 唯一生产级推进方案：目标、任务流、放行标准、未实现项。 |
| [CONTROL_SYSTEM.md](CONTROL_SYSTEM.md) | Control、Hermes、OMLX、GameStudio Server 的系统说明和边界。 |
| [PRODUCT_AND_STORY_WORKFLOW.md](PRODUCT_AND_STORY_WORKFLOW.md) | 产品定位、项目结构、三层故事工作流和新生产任务流。 |
| [UI_SELF_CONSTRAINTS.md](UI_SELF_CONSTRAINTS.md) | 前端 UI 约束；仍被开发指令直接引用。 |

## 维护规则

- 当前状态、session ID、测试流水和一次性结论不写入 `docs/`。
- 已完成的实施细节只保留一句能力摘要，详细过程进入 `state/` 或测试 artifacts。
- 未实现项必须显式标出，不能用“后续优化”模糊代替。
- 新文档默认不新增；优先合并到以上权威文档。