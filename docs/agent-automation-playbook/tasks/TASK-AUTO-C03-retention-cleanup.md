# AUTO-C03：缓存、session 与日志保留清理

## 任务目标

为长期运行建立可配置的 TTL/保留策略，避免缓存、session 文件和 chat history 无限增长，同时保留活跃任务与审计证据。

## 前置依赖

- AUTO-C01、AUTO-C02 必须完成本地验收。

## 范围内

- sessionCallCounts、inspectModelAccessCache、reasoning sessions、chat history 的清理服务。
- TTL、归档/删除规则、dry-run/统计和测试。

## 范围外

- 不删除活跃队列、未终结 session 或未归档 evidence。
- 不修改项目产物保留规则。

## 必须满足

1. 每类数据有明确 TTL 或保留上限及默认安全值。
2. 清理只处理满足条件的终结/已归档记录。
3. 活跃 task、checkpoint、pending review 和未归档证据绝不被删除。
4. 清理有可追溯报告，支持 dry-run 或等价预览。
5. 过期删除、活跃保护、归档保护和重复运行幂等都有测试。

## 交付证据

- 保留策略配置与清理实现。
- dry-run/执行报告、TTL 和保护路径测试输出。
- 不删除活跃任务的反向证据。

### 保留策略表（env 可配 + 安全默认）

| 数据 | 策略 | env | 默认 |
| --- | --- | --- | --- |
| sessionCallCounts（内存） | 上限淘汰，跳过 global 与活跃 session | `HERMES_MODEL_TASK_SESSION_CALL_CACHE_MAX_ENTRIES` | 500 |
| inspectModelAccessCache（内存） | TTL 过期 + 上限淘汰（淘汰只触发重探测） | `HERMES_INSPECT_MODEL_CACHE_TTL_MS` / `HERMES_INSPECT_MODEL_CACHE_MAX_ENTRIES` | 24h / 200 |
| reasoning session 文件 | 终态/failed 超 TTL 先归档后删除 | `HERMES_RETENTION_SESSION_TTL_DAYS` | 30 |
| queue item 文件 | 终态超 TTL 且 session 已清理/缺失，先归档后删除 | `HERMES_RETENTION_QUEUE_ITEM_TTL_DAYS` | 30 |
| step checkpoint 文件 | 随已清理 session 随迁；孤儿超 TTL 且 queue item 缺席/终结 | `HERMES_RETENTION_CHECKPOINT_TTL_DAYS` | 30 |
| chat history | 既有 lifecycleMaintenance：mtime 超期归档 + 单文件条目上限 | `HERMES_CHAT_ARCHIVE_AFTER_DAYS` / `HERMES_CHAT_MAX_ENTRIES_PER_FILE` | 30 / 120 |
| 调度 | 挂既有 `scheduleMemoryLifecycleMaintenance`，低频门控 | `HERMES_RETENTION_CLEANUP_ENABLED` / `HERMES_RETENTION_CLEANUP_INTERVAL_MS` | on / 6h |

### 修改文件清单

- 新增 `apps/control-server/src/server/reasoning/retentionCleanup.js`：策略解析、`runReasoningRetentionCleanup`（session/queue item/checkpoint 三段清理 + dry-run + 报告）、`pruneTtlCache` / `evictOldestCacheEntries` 内存缓存淘汰原语。
- `apps/control-server/src/server/controlServerCore.js`：`runScheduledRetentionCleanup` 挂入 `runMemoryLifecycleMaintenanceNow`（统一调度点，低频门控，活跃句柄经 `protectedSessionIds` 硬保护）；`inspectModelAccessCache` 三处写入改经 `cacheInspectModelAccessResult`（TTL+上限淘汰）。
- `apps/control-server/src/server/model/modelTaskQueue.js`：`sessionCallCounts` 上限淘汰（`pruneSessionCallCounts`，reserve 路径自动触发；global 与排队/运行中 session 保护）；导出 `reserveSessionCall` / `getSessionCallCountsSnapshot` 供测试。
- `apps/control-server/src/server/memory/lifecycleMaintenance.js`：chat 归档阈值与条目上限 env 化（默认值与行为不变）。
- 新增 `scripts/test/retentionCleanup.test.mjs`（16 例）。

### 测试命令与结果

- `node --test scripts/test/retentionCleanup.test.mjs`：16/16 通过。
- `node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs`：142/142 通过（基线 126 + 新增 16，不回归）。
- `node --check` 全部改动文件通过。
- `sh restart_control.sh` 启动冒烟：健康检查通过；真实 `state/` 数据两轮启动清理均 0 删除 0 错误（28 session `within_ttl`、1 孤儿 checkpoint `orphan_within_ttl`），报告落 `state/retention-cleanup/latest-report.json` + `history.jsonl`。

dry-run 报告样例（测试构造：过期终态 session + checkpoint + 终结 queue item）：

```json
{
  "dryRun": true,
  "summary": { "scanned": 3, "deleted": 3, "kept": 0, "archived": 0, "errors": 0 },
  "entries": [
    { "category": "reasoningSessions", "id": "s_dry(agent-runtime-sessions)", "action": "delete", "reason": "terminal_expired", "ageDays": 40, "archived": false },
    { "category": "queueItems", "id": "s_dry", "action": "delete", "reason": "terminal_expired", "ageDays": 40, "archived": false },
    { "category": "checkpoints", "id": "s_dry/s_dry_step_0.json", "action": "delete", "reason": "session_cleaned", "ageDays": 40, "archived": false }
  ]
}
```

dry-run 零副作用已断言：原件全在、归档目录与报告目录均未创建。

### 不删除活跃任务的反向证据

- 8 种非终态 session 状态（queued/running/waiting_review/retry_wait/orphaned/paused/pausing/resuming）超龄 90 天仍全部保留；4 种非终态 queue item（queued/claimed/running/waiting_review）及其孤儿 checkpoint 同样保留。
- `review.status=pending` 的终态/failed session 保留；`protectedSessionIds` 内 session 保留；TTL 内 failed 重试证据保留；归档失败时原件保留并记 `archive_failed_kept`。

### 取舍

- failed 不算状态机终态（有 retry 路径），但超 TTL 后证据价值耗尽，按可清理处理（与终态同一 TTL）。
- 删除一律「先归档后删除」（`state/memory-archive/retention/` 留副本），未归档证据绝不硬删；与 `maintenance/retention.js`（人工运维归档迁移、不硬删、不感知 queue/checkpoint/缓存）分工，不另起平行调度。
- queue item 与 session 同生命周期：session 仍保留时 item 作为证据保留；session 清理/缺失后 item 才可删。
- 低频门控为进程内存态：进程重启后首轮维护必跑一次（幂等、只读扫描为主），长期运行进程内 6h 一次。

### 风险

- 归档目录 `state/memory-archive/retention/` 自身无 TTL（与 `state/memory-archive/chat` 一致，由人工运维/`maintenance/retention.js` 归档批次管理）；长期看归档体积有界增长，如需归档清理可后续加 archive TTL。
- `maintenance/retention.js` 人工触发的 session 归档迁移会把 session 移出原目录，对应 checkpoint 成为孤儿，需超 TTL 且 queue item 缺席/终结才被本模块清理（保守保留）。
- 同 sessionId 在 runtime/legacy 两目录的副本只解析第一份评估；第二份损坏时随评估一并归档删除（副本已在归档留证，影响可接受）。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02