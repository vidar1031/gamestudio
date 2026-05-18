# GameStudio 文档目录

本文档目录已精简为 **4 个核心文档**，不再保留重复或分散的说明。

| 文档 | 用途 | 面向读者 |
|------|------|----------|
| [`PROJECT_GOVERNANCE.md`](PROJECT_GOVERNANCE.md) | 全系统最高治理规则：文档层级、记忆管理、禁止行为、违规处理 | 所有 Agent、开发者、维护者 |
| [`系统生产级推进方案.md`](系统生产级推进方案.md) | 系统分工（明确行为边界）、启动流程、生产任务流、路由规则、UI 约束、放行标准、关键文件索引 | 开发者、维护者 |
| [`Control + GameStudio 生产工作流联调测试说明.md`](Control%20+%20GameStudio%20生产工作流联调测试说明.md) | 联调测试标准、阶段定义、验证检查清单、当前测试结果、下一步重点 | 测试人员、开发者 |
| [`PRODUCTION_DEFECTS.md`](PRODUCTION_DEFECTS.md) | 当前生产缺陷（P0/P1/P2）、未实现功能清单、已修复归档 | 开发者、维护者 |

## 阅读顺序

1. **新加入的 Agent** → 先读 `PROJECT_GOVERNANCE.md`，了解什么能做、什么不能做。
2. **要启动或调试系统** → 读 `系统生产级推进方案.md` 的"启动流程"和"系统分工"章节。
3. **要执行联调测试** → 读 `Control + GameStudio 生产工作流联调测试说明.md`，按验证检查清单执行。
4. **要修复缺陷或推进功能** → 读 `PRODUCTION_DEFECTS.md`，确认缺陷状态和修复方向。

## 已合并/删除的旧文档

以下文档的内容已合并到上述 4 个文档中，原文件已删除：

- ~~`CONTROL_SYSTEM.md`~~ → 合并到 `系统生产级推进方案.md`（模块结构、核心链路、路由规则）和 `PROJECT_GOVERNANCE.md`（安全边界、记忆规则）
- ~~`CONTROL_TO_GAMESTUDIO_CHAIN.md`~~ → 合并到 `系统生产级推进方案.md`（启动流程、通信契约、错误处理、关键文件索引）和 `Control + GameStudio 生产工作流联调测试说明.md`（验证检查清单）和 `PRODUCTION_DEFECTS.md`（缺陷清单）
- ~~`PRODUCT_AND_STORY_WORKFLOW.md`~~ → 合并到 `系统生产级推进方案.md`（产品定位、项目结构、三层故事工作流）
- ~~`Control Console 使用说明.md`~~ → 合并到 `系统生产级推进方案.md`（指令分类、productionTest 模式、设计原则）
- ~~`UI_SELF_CONSTRAINTS.md`~~ → 合并到 `系统生产级推进方案.md`（UI 约束章节）
