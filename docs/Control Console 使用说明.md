# Control Console 使用说明

## 1. 说明概览
Control Console 是 GameStudio 的前端交互界面，使用 Vue + Vite 开发。它负责接收用户的自然语言指令，经过审计后交给后端 Control Server 进行任务编排、执行并返回结果。

## 2. 主要功能
- **任务输入**：在聊天框或命令行样式输入，支持多种指令类型（查询、创建、修改、导出等）。
- **审核与进度展示**：每条指令都会被 Control Server 决策路由，若需审计会弹出审核页面；执行中会实时更新状态（queued、running、completed、failed）。
- **生命周期管理**：支持暂停、取消、恢复已提交任务。也可一次性终止所有当前 session。

## 3. 指令分类

指令通过启发式模式匹配（heuristics）进行分类，匹配到的是 prompt 中包含的关键词/短语，而不是行首固定前缀。分类优先级由 `config/hermes/routing/request_classification_rules.json` 中的 `priority` 字段决定（数值越高越优先）。

| 类型 | 说明 | 触发关键词/短语 | 优先级 | 需审核 |
| ---- | ---- | ---------------- | :----: | :----: |
| **answer_only** | 仅返回文本答案，不涉及项目事实。查询通用概念或原理。 | `是什么` `为什么` `解释` `说明` `区别` `含义` `原理` `建议` `是否合理` `会不会有问题` `对不对` `what` `why` `explain` `suggest` `reasonable` | 20 | 否 |
| **inspect_then_answer** | 查询系统状态、功能能力状态等信息。 | 项目状态查询、`项目能力状态查询` | 40 | 否 |
| **plan_then_answer** | 读取项目资料做检查，随后返回答案。默认兜底分类。 | 目录/文件/项目相关的查询词（项目列表、目录列表、文件检查、目录检查、编辑器位置、业务服务器位置等）；对话继续词（`继续` `接着` `按照` `基于` `根据` `上面` `之前` `刚才` `这个设计` `这套方案` `实施` `推进` `修复` `落地` `同步文档` `计划` `规划` `方案` `检查` `分析`） | 55–95 | 否 |
| **workflow_execute** | 创建、配置、校验、导出等生产任务（无需人工审核）。 | GameStudio 启动/自检/诊断词（`gamestudio`/`游戏工作室` + `启动`/`打开`/`界面`/`工作台`/`自检`/`检查`/`配置`/`diagnose`/`preflight`/`bootstrap`）；故事项目自动化词（`创建.*故事` `新建.*故事` `生成.*故事` `故事项目` `互动故事` `项目配置` `生成配置` `配置.*落盘` `生成结果` `导出项目` `export project` `validate project` `锁定测试` 等）；行动动词（`创建` `新建` `生成` `配置` `检查` `确认` `校验` `验证` `导出` `制作` `执行` `运行` `测试` 等） | 120–130 | 否 |
| **write_or_invoke_review** | 写入文件、删除、脚本执行等需审核的操作。 | 变更操作词（`写入` `修改` `编辑` `删除` `重命名` `落盘` `应用修改` `执行脚本` `运行脚本` `重启` `启动` `停止` `恢复` `暂停` `调用接口` `run script` `execute script` `restart` `start` `stop` `delete` `rename` `edit` `write`）— 当同时不包含否定词（`是否` `为什么` `解释` `说明` `检查` `分析` `能否` `可否`）时才匹配 | 110 | 是 |

> **注意**：`write_or_invoke_review` 使用"正向模式 + 负向排除"机制。如果 prompt 同时匹配变更操作词和否定词（如"能否检查一下写入流程"），则不会归类为 write_or_invoke_review，而会落入 plan_then_answer 或 answer_only。
>
> 如果所有规则都不匹配，则使用默认兜底分类 `plan_then_answer`（对话上下文类）。

## 4. 操作流程
1. **输入指令** → Console 发送至 Control Server。
2. **Control Server 决策**：依据路由规则决定执行路径。
3. **执行 & 评估**：若为 workflow 执行，触发 Hermes、OMLX、GameStudio Server 等；若为查询则直接返回。
4. **结果返回**：在 Console 中显示最终答案或任务状态。

## 5. 常见使用示例

以下示例按路由分类从高到低排列，展示不同指令的实际分类结果：

- **workflow_execute（无需审核）**：
  - `导出项目 ABC 为 ZIP` → 匹配 `故事项目自动化` 规则（`导出项目`），触发 GameStudio Server 导出 API。
  - `启动游戏工作室 自检` → 匹配 `GameStudio 启动/诊断` 规则（`gamestudio.*自检`），触发 bootstrap 诊断流程。
  - `创建故事项目 ABC` → 匹配 `故事项目` 规则 + 行动动词 `创建`，触发故事工作流。

- **write_or_invoke_review（需要审核）**：
  - `暂停任务 123` → 匹配 `write_or_invoke_review` 模式（`暂停`），标记需人工审核，审核通过后才执行暂停操作。

- **plan_then_answer（默认兜底）**：
  - `创建新项目 ABC` → 不匹配故事工作流模式（缺少"故事"相关关键词），归类为 `plan_then_answer`，由模型决定如何处理。
  - `检查项目 ABC 代码覆盖率` → 匹配 `plan_then_answer` 的对话继续词模式（`检查`），读取项目资料后返回答案。

- **answer_only（最低优先级）**：
  - `Hermes 和 OMLX 有什么区别` → 匹配 `answer_only` 模式（`区别`），直接返回解释，不触及项目文件。

## 6. 设计原则
- **确定性优先**：先按固定 workflow 处理，只有在规则不匹配时才委托 Hermes。
- **安全边界**：所有写入/删除操作必须通过 review gate；工作空间外路径均拒绝。
- **可观测性**：state/ 目录保存所有运行记录，便于审计与复盘。

## 7. 进一步帮助
- 访问 `CONTROL_SYSTEM.md` 获得更深层次的技术细节。
- 查看 `CONTROL_GAMESTUDIO_PRODUCTION_WORKFLOW_TEST.md` 了解生产测试用例。
- 若遇到错误，检查 `state/` 下的日志文件或联系维护人员。