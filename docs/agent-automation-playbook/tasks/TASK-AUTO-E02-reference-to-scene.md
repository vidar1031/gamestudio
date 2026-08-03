# AUTO-E02：锁定资产到场景渲染闭环

## 任务目标

建立“先锁定角色参考图，再渲染场景，回填并校验导出”的强制 P1 生产闭环。

## 前置依赖

- AUTO-E01 必须完成本地验收。

## 范围内

- reference required 门禁、scene render 输入绑定、产物回填、validate/export 证据。

## 范围外

- 不允许缺参考图时降级成无参考生成。
- 不实现多 scene 队列（AUTO-E03）。

## 必须满足

1. 需要角色参考图的 scene 在引用缺失时明确 BLOCKED。
2. 已锁定且真实存在的参考图会被传给场景渲染输入。
3. 成功场景图回填项目数据，并通过 validate 和 export。
4. 无效引用、评审失败或渲染失败不污染已有成功资产。
5. 缺引用阻断、成功回填、validate/export 和失败隔离均有测试/受控样例。

## 交付证据

- 门禁、渲染输入、回填和导出实现。
- 缺引用 BLOCKED 与成功 scene 的项目/文件/导出证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-E01