# AUTO-E01：角色资产生产链路

## 任务目标

让角色资产可生成、评审、持久化，并将通过评审的真实文件写入 `primaryReferenceAssetUri`。

## 前置依赖

- AUTO-A02、AUTO-B04、AUTO-C01、AUTO-C02 必须完成本地验收。
- P0 文本生产链路必须保持通过。

## 范围内

- character asset plan、生成请求、视觉评审、持久化引用和回归验证。

## 范围外

- 不绕过 reviewer 或伪造图像成功。
- 不实现批量 scene 调度（AUTO-E03）。

## 必须满足

1. 至少一个角色可从 asset plan 生成候选并获得可追溯评审结果。
2. 仅通过评审且文件真实存在的候选可写入 `primaryReferenceAssetUri`。
3. 生成/评审失败进入 FAIL 或 BLOCKED，不写假引用。
4. 资产记录、文件和项目 schema 引用一致。
5. 成功、评审失败、文件缺失路径均有测试或真实受控样例。

## 交付证据

- 角色资产实现和 schema/项目文件证据。
- 真实存在的引用 URI、评审记录和失败阻断样例。
- P0 回归结果。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-A02, AUTO-B04, AUTO-C01, AUTO-C02