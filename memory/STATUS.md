# GameStudio 项目状态

- 最近检查: 2026-05-15 任务拆解启动
- `apps/server` 已存在，并已具备项目读写、脚本/蓝图/合成、校验、导出和部分资产 API。
- `storage/projects` 已存在，是故事项目创建与持久化目录。
- Control Server 已新增 story workflow actions、GameStudio Server API client、deterministic evaluator、失败短路、资源引用校验、当前项目指针、deterministic L4 artifact answer 和 story workflow runtime-bypass 窄口径保护。
- L4 优先批已全绿：L4-01、L4-02、L4-04、L4-05、L4-08、L4-15、L4-16、L4-17、L4-18，PASS=9。
- 最新文本闭环项目 `14d4f930-c4e9-4681-ac9c-b5a2ed0542df` 已完成 create/config/scripts/blueprint/compose/validate/export。
- 最新导出产物：`/demos/14d4f930-c4e9-4681-ac9c-b5a2ed0542df/latest/dist/index.html`，本地路径 `storage/projects/14d4f930-c4e9-4681-ac9c-b5a2ed0542df/builds/latest/dist/index.html`（不存在，上次导出路径引用错误）。
- Control Server (localhost:8868) 2026-05-14 13:08 运行中，Vite dev server，返回 HTML 页面，`/health` 端点 HTTP 200。
- ComfyUI (localhost:8188) 2026-05-14 13:08 未运行，端口无监听。
- 10 个故事项目存在于 `storage/projects/`，包含完整蓝图、script、story 数据。

## 当前重点：Control Console 触发规则展示与失败处理

### 已完成分析 (CT-001)
- `config/hermes/routing/request_classification_rules.json` 已有 12 条规则
- `apps/control-server/src/server/reasoning/requestClassificationRules.js` 定义了所有 detector
- `apps/control-server/src/server/reasoning/requestClassifier.js` 完成了类型→路由的映射
- 用户提供的 5 个路由类型（answer_only, plan_then_answer, inspect_then_answer, workflow_execute, write_or_invoke_review）在代码中已存在
- **缺陷**：Control Console 前端无任何路由/分类信息展示
- **缺陷**：无 API 端点暴露路由表内容
- **缺陷**：无触发规则失败（unmatched prompt）的用户可见处理

### 新任务队列
- CT-002: 在 control-server 新增 GET /api/control/routing 端点
- CT-003: 在 request_classification_rules.json 补充 human-readable 触发规则描述
- CT-004: 在 Control Console 前端添加分类信息展示页面
- CT-005: 添加触发规则匹配失败时的 fallback 处理机制
- CT-006: 端到端测试

### 剩余缺口：ComfyUI 重启、L5 边界测试、图片 provider 可用性。
