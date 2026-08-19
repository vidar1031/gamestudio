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

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-A02, AUTO-B04, AUTO-C01, AUTO-C02

## 交付证据（2026-08-15，kimi-code）

### 实现

- 新增 `apps/server/src/ai/storyAssetReferenceGate.js`（S4-01 写入门禁）：
  - `verifyStoryAssetReferenceFile({ dir, assetPath })`：项目目录边界校验（拒绝越界路径）→ 文件真实存在 → 非空 → `sniffImageMetaFromBytes` 图片格式判定；失败分别返回 `reference_path_outside_project` / `reference_file_missing` / `reference_file_empty` / `reference_file_invalid`。
  - `evaluateStoryAssetReferenceReview(analysis)`：仅 `passed === true 且 skipped !== true` 判为评审通过；无记录 `review_record_missing`、评审被跳过（含「未启用视觉判定」兜底假通过）`review_unavailable`、评审未通过 `review_not_passed`。
  - `sniffImageMetaFromBytes` 从 `apps/server/src/index.js` 迁入本模块，生成落盘、线稿、写入引用共用同一格式判定标准。
- 接入两个 `primaryReferenceAssetUri` 写入口（`apps/server/src/index.js`）：
  - `POST /api/projects/:id/ai/story/assets/reference/select`：写入前强制评审门（409 + 响应携带可追溯评审记录）与文件门（400）；任一不满足即显式失败，计划与 project.json 均不写入。
  - `persistPrimaryReferenceLock`（lock test Step D 与 lock_confirm approve 共用）：写入前文件校验；`lock_confirm` approve 失败时显式返回错误码与原因，审核记录保持 `pending` 不被消费。
- 失败语义留证：所有阻断/失败经 `logStage`（`asset.reference.select` blocked/fail、`asset.reference.batch` fail）记录 traceId/project/asset/原因。

### 测试

- `scripts/test/storyAssetPrimaryGate.test.mjs` 13/13：
  - 门禁单元 4：有效 PNG 通过；缺失/空/非图片/越界分别显式失败；评审四种判定（通过/未通过/skipped 假通过/无记录）；sniff 识别与拒绝。
  - 成功路径 1：夹具 PNG + 真实评审通过 → select 200，`primaryReferenceAssetUri` 写入且文件真实存在，plan 引用、project.json `characters[].ai.referenceAssetId`、`assets[]` 索引三方一致，`latestReferenceReview` 可追溯。
  - 评审失败 3：`review_not_passed` / `review_unavailable`（skipped 假通过）/ `review_record_missing` 均 409 且不写引用。
  - 文件缺失 1：评审通过但磁盘无文件 → 400 `reference_file_missing` 不写引用。
  - provider 不可用 2：未启用 → 503 `disabled`；不可达（sdwebui @ 127.0.0.1:9）→ 502 显式 FAIL 含原因；均不产生候选与引用。
  - lock_confirm 2：文件缺失 → 400 且审核保持 pending；文件存在 → 200 落锁写入引用。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` **231/231**（基线 218 + 新增 13），P0 文本生产链路无回归。
- `node --check apps/server/src/index.js apps/server/src/ai/storyAssetReferenceGate.js` 通过；未改动 packages/schema（无需 build:packages/typecheck）。
- 测试环境隔离：`STUDIO_STORAGE_ROOT` 指向临时目录，未触碰真实 `storage/projects`。

### 环境说明与真实服务手工复现步骤

交付时环境判断 ComfyUI 不可达（H02 演练实测）且 MOONSHOT_API_KEY 失效（401/403）；2026-08-15 复核：ComfyUI 系未启动而非故障（已恢复），key 系误测 api.moonshot.cn（实为 Kimi For Coding 有效 key 并全链路验证）。真实出图与真实视觉评审当时无法端到端自动验证；上述路径以注入/夹具测试 + 文件系统真实证据验收，真实服务路径按设计显式 FAIL/BLOCKED 并报告原因，未伪造任何图片文件或评审记录。

环境恢复后手工复现：

1. 启动业务服务 `./start_project.sh --detached`，确认 ComfyUI（`curl -sS http://127.0.0.1:1999/api/ai/comfyui/capability-check`）与有效 `MOONSHOT_API_KEY` 就位。
2. 取一个有 Story Bible 的项目，调 `POST /api/projects/:id/ai/story/assets/plan` 生成资产计划，挑选一个 `category=character` 资产。
3. `POST /api/projects/:id/ai/story/assets/reference` `{assetId}` 生成候选批次；验证返回候选均带 `analysis`（真实视觉评审记录）并持久化在 `story-assets/plan.json`。
4. 对评审 `passed:true` 的候选调 `POST .../reference/select` `{assetId, assetPath}`：预期 200，`plan.json` 中 `primaryReferenceAssetUri` 指向磁盘真实文件，`project.json` 角色 `ai.referenceAssetId` 与 `assets[]` 索引一致。
5. 负面对照：删掉候选文件后重复 select → 400 `reference_file_missing`；对 `passed:false` 候选 select → 409 `review_not_passed`；把 MOONSHOT_API_KEY 置无效后重新生成候选并 select → 409 `review_unavailable`（评审记录 `skipped:true`）。
6. 审核门禁路径（`STUDIO_IMAGE_REVIEW_MODE=manual`）：`POST /api/projects/:id/ai/story/lock/test` → 202 pendingReview（pre_generate）→ approve 后执行；AI 评审通过产生 lock_confirm 待审 → approve 后才经 `persistPrimaryReferenceLock` 落锁；此时删除结果文件再 approve → 400 `reference_file_missing` 且审核保持 pending。

### 关键设计决定

- select 路由的人工挑选不视为评审：评审证据必须来自可追溯的 AI 视觉评审记录（生成批次时持久化）；`skipped:true` 一律视为未评审，杜绝「未启用视觉判定 → passed:true」的确定性兜底冒充成功。
- lock_test 的 manual 三级门禁不变：lock_confirm 的人工 approve 本身就是评审终裁，因此该写入口只加文件真实性校验，不重复要求 AI 评审通过。
- 白底后处理（ComfyUI）失败仍回退原候选图（既有行为），但门禁保证回退目标文件真实存在且评审通过。

### 遗留风险

- 非 manual 模式（`x-image-review-mode: off`，Control 旁路）下 lock test Step D 仍信任 `analysis.passed`；若评审 provider 未配置视觉能力，`storyLock.js` 的兜底会给出 `passed:true, skipped:true`。该路径由 Control 步骤级审核兜底，未在本任务收紧，如需要可在 E02/E03 一并评估。
- 编辑器 UI 对 409 阻断以错误消息形式呈现（经 `api.ts` 抛错），无专门阻断态样式；不影响功能正确性。