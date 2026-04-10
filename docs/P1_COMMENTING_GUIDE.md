# P1 注释与说明规范

目标：让后续开发在“多人+多 Provider+多阶段任务”下仍可快速定位与维护。

## 1. 注释原则

1. 只解释“为什么”，不重复“做了什么”。
2. 只在复杂逻辑边界写注释（状态迁移、容错、跨服务调用）。
3. 注释必须可维护：出现过期说明时，改代码必须同时改注释。

## 2. 推荐注释块（模板）

```ts
// P1:<area>
// Why:
// - 业务意图（1-2 行）
// Risks:
// - 失败模式（超时/回退/兼容）
// Contract:
// - 输入/输出关键约束
```

示例 area：
- `P1:storyboard-prompt`
- `P1:comfyui-apply`
- `P1:state-migration`
- `P1:provider-fallback`

## 3. 日志规范（必须）

日志统一前缀：`[gamestudio]`

最小字段：
- `stage`（如 `bg.prompt` / `bg.create`）
- `project`
- `provider`
- `model`
- `ms`
- `ok/fail` 或 `status`
- `err`（失败时）

建议字段：
- `traceId`
- `mode`（all/pending）
- `item`（场景名或 nodeId）

## 4. TODO 规范（P1）

统一格式：
```ts
// TODO(P1-M2): <一句话目标> | Owner: <name/role> | Exit: <完成判定>
```

示例：
```ts
// TODO(P1-M2): 将批量出图迁移到任务队列，支持取消与恢复 | Owner: editor-runtime | Exit: 支持取消后继续未完成
```

## 5. 文档链接规范

涉及跨模块逻辑时，注释里附文档路径：
- `docs/DESIGN_P1.md`
- `docs/P1_COMMENTING_GUIDE.md`
- `docs/P0_REVIEW_2026Q1.md`

示例：
```ts
// 详见 docs/DESIGN_P1.md#42-任务语义
```

## 6. PR 提交要求（P1）

每个 PR 描述必须包含：
1. 变更阶段（M1/M2/M3）
2. 影响链路（提示词/出图/状态/导出）
3. 失败回退策略
4. 测试证据（命令 + 结果）
