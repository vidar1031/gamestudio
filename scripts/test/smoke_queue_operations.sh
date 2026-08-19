#!/usr/bin/env bash
# AUTO-D01 smoke：队列/task 运维入口关键流程的可重复证据。
# 覆盖：列表 join 一致性、详情证据索引、取消反馈与刷新一致、重试/恢复的成功或阻断原因透传。
# 用法：先启动 control（sh restart_control.sh），再执行本脚本。
#   CONTROL_BASE_URL 可覆盖目标地址（默认 http://127.0.0.1:2099）。
# 说明：脚本在真实 state/ 下写入 smoke_d01_ 前缀的夹具（session/queue item/checkpoint），
# 结束时全部清理；夹具任务不会被 worker 执行的前提与生产一致——runtime 未运行时任务保持排队。
set -euo pipefail

BASE_URL="${CONTROL_BASE_URL:-http://127.0.0.1:2099}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION_DIR="$ROOT/state/agent-runtime-sessions"
QUEUE_DIR="$ROOT/state/reasoning-queue"
CHECKPOINT_DIR="$ROOT/state/reasoning-checkpoints"

mkdir -p "$SESSION_DIR" "$QUEUE_DIR" "$CHECKPOINT_DIR"

SID_FAILED="smoke_d01_failed"
SID_QUEUED="smoke_d01_queued"
SID_ORPHAN="smoke_d01_orphan"

cleanup() {
  rm -f "$SESSION_DIR/$SID_FAILED.json" "$SESSION_DIR/$SID_QUEUED.json" "$SESSION_DIR/$SID_ORPHAN.json" \
        "$QUEUE_DIR/$SID_FAILED.json" "$QUEUE_DIR/$SID_QUEUED.json" "$QUEUE_DIR/$SID_ORPHAN.json" \
        "$CHECKPOINT_DIR/${SID_FAILED}_step_0.json" "$CHECKPOINT_DIR/${SID_ORPHAN}_step_0.json"
  # HERMES-H01：治理动作会写审计文件，smoke 夹具的审计记录一并清理
  local audit_file="$ROOT/state/governance-audit.jsonl"
  if [ -f "$audit_file" ]; then
    grep -v 'smoke_d01_' "$audit_file" > "$audit_file.tmp" 2>/dev/null || true
    mv "$audit_file.tmp" "$audit_file"
  fi
}
trap cleanup EXIT

echo "== 0. control server 健康检查 =="
curl -sS "$BASE_URL/api/health" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok'), d; print('ok:', d['service'])"

echo "== 1. 写入 smoke 夹具（failed / queued / orphaned 各一） =="
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
SID_FAILED="$SID_FAILED" SID_QUEUED="$SID_QUEUED" SID_ORPHAN="$SID_ORPHAN" NOW="$NOW" \
SESSION_DIR="$SESSION_DIR" QUEUE_DIR="$QUEUE_DIR" CHECKPOINT_DIR="$CHECKPOINT_DIR" node --input-type=module <<'EOF'
import fs from 'node:fs'
import path from 'node:path'
const { SID_FAILED, SID_QUEUED, SID_ORPHAN, NOW, SESSION_DIR, QUEUE_DIR, CHECKPOINT_DIR } = process.env
const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2), 'utf8')
const makeSession = (sessionId, status, extra = {}) => ({
  sessionId, runtimeSessionId: sessionId, sessionKind: 'agent-runtime', agentId: 'hermes-manager',
  userPrompt: 'smoke 运维任务', title: `smoke 运维任务（${status}）`,
  submissionContext: { projectId: 'smoke_d01_proj' }, parentSessionId: null, childSessionIds: [],
  status, createdAt: NOW, updatedAt: NOW, runtimeTaskGraph: null,
  plan: { steps: [{ stepId: 's0', title: '生成故事草稿', action: 'write' }, { stepId: 's1', title: '校验故事', action: 'validate' }] },
  currentStepId: null, currentStepIndex: 0, review: null,
  error: extra.error || null,
  events: [{ type: 'queue_retry_scheduled', title: '任务进入重试等待', summary: '第 1 次重试', timestamp: NOW }],
  stateTransitions: [], artifacts: extra.artifacts || {}
})
const makeItem = (sessionId, status, extra = {}) => ({
  version: '1', taskId: sessionId, sessionId, projectId: 'smoke_d01_proj', status,
  claim: { workerId: null, claimedAt: null, claimGeneration: 0 },
  attempts: 1, recoveryCount: 0, resumeFromStep: null, lastError: extra.lastError || null,
  retryCount: extra.retryCount || 0, nextAttemptAt: null, retryHistory: extra.retryHistory || [],
  createdAt: NOW, updatedAt: NOW, startedAt: NOW, finishedAt: status === 'queued' ? null : NOW,
  history: [{ from: null, to: status, reason: 'smoke_fixture', workerId: null, at: NOW }]
})
// failed：重试达上限后稳定失败（带重试记录与 checkpoint 证据）
writeJson(SESSION_DIR, `${SID_FAILED}.json`, makeSession(SID_FAILED, 'failed', {
  error: 'model_http_503',
  artifacts: { retryPolicy: { retryCount: 2, maxAttempts: 2, exhausted: true } }
}))
writeJson(QUEUE_DIR, `${SID_FAILED}.json`, makeItem(SID_FAILED, 'failed', {
  lastError: 'model_http_503', retryCount: 2,
  retryHistory: [
    { attempt: 1, scheduledAt: NOW, nextAttemptAt: NOW, backoffMs: 1000, rule: 'network_error', reason: '网络错误' },
    { attempt: 2, scheduledAt: NOW, nextAttemptAt: NOW, backoffMs: 2000, rule: 'network_error', reason: '网络错误' }
  ]
}))
writeJson(CHECKPOINT_DIR, `${SID_FAILED}_step_0.json`, {
  version: '1', sessionId: SID_FAILED, stepId: 's0', stepIndex: 0, nextStepIndex: 1, completedAt: NOW
})
// queued：排队中（用于取消 + 刷新一致性）
writeJson(SESSION_DIR, `${SID_QUEUED}.json`, makeSession(SID_QUEUED, 'queued'))
writeJson(QUEUE_DIR, `${SID_QUEUED}.json`, makeItem(SID_QUEUED, 'queued'))
// orphaned：异常中断待恢复（带合法 checkpoint）
writeJson(SESSION_DIR, `${SID_ORPHAN}.json`, makeSession(SID_ORPHAN, 'orphaned'))
writeJson(QUEUE_DIR, `${SID_ORPHAN}.json`, makeItem(SID_ORPHAN, 'blocked'))
writeJson(CHECKPOINT_DIR, `${SID_ORPHAN}_step_0.json`, {
  version: '1', sessionId: SID_ORPHAN, stepId: 's0', stepIndex: 0, nextStepIndex: 1, completedAt: NOW
})
console.log('fixtures written')
EOF

echo "== 2. 列表：queue item join session 摘要（状态/当前步骤/重试/原因） =="
curl -sS "$BASE_URL/api/control/queue/items" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
by_id={i['sessionId']:i for i in d['items']}
f=by_id['$SID_FAILED']
assert f['status']=='failed' and f['retryCount']==2, f
assert f['session']['status']=='failed' and f['session']['error']=='model_http_503', f
assert f['session']['stepCount']==2 and f['session']['currentStepIndex']==0, f
q=by_id['$SID_QUEUED']
assert q['status']=='queued' and q['session']['status']=='queued', q
o=by_id['$SID_ORPHAN']
assert o['status']=='blocked' and o['session']['status']=='orphaned', o
print('列表一致：failed(retry=2,error=model_http_503) / queued / orphaned(blocked) 均正确 join')"

echo "== 3. 详情：证据索引（checkpoint / 重试计划 / 重试记录 / 最近事件） =="
curl -sS "$BASE_URL/api/control/queue/items/$SID_FAILED" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
assert d['item']['retryHistory'][1]['rule']=='network_error', d['item']
assert d['evidence']['latestCheckpoint']['nextStepIndex']==1, d['evidence']
assert d['evidence']['retryPolicy']['exhausted'] is True, d['evidence']
assert d['evidence']['recentEvents'], d['evidence']
assert d['session']['currentStep']['title']=='生成故事草稿', d['session']
print('详情证据：checkpoint nextStepIndex=1、retryPolicy.exhausted、retryHistory=2 条、最近事件、当前步骤均返回')"
curl -sS "$BASE_URL/api/control/queue/items/no_such_item" -o /dev/null -w '缺失 item -> HTTP %{http_code}（预期 404）\n'

echo "== 4. 取消：queued 任务取消 -> 成功后刷新与服务端一致（item 镜像 cancelled） =="
curl -sS -X POST "$BASE_URL/api/control/agents/hermes-manager/reasoning-sessions/$SID_QUEUED/cancel" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'] and d['session']['status']=='cancelled', d
print('取消成功：session -> cancelled')"
sleep 2
curl -sS "$BASE_URL/api/control/queue/items" | python3 -c "
import json,sys
d=json.load(sys.stdin)
q={i['sessionId']:i for i in d['items']}['$SID_QUEUED']
assert q['status']=='cancelled' and q['session']['status']=='cancelled', q
print('刷新一致：queue item 已镜像为 cancelled（服务端调度器收敛，非本地臆测）')"

echo "== 5. 重试：failed 任务人工重试 -> 成功或阻断原因透传 =="
RETRY_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/agents/hermes-manager/reasoning-sessions/$SID_FAILED/retry" -o /tmp/smoke_d01_retry.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_d01_retry.json'))
http='$RETRY_HTTP'
if http=='200':
    assert d['ok'] and d['session']['status']=='queued' and d['item']['status']=='queued', d
    assert d['item']['retryCount']==0 and len(d['item']['retryHistory'])==2, d['item']
    print('重试成功：session/item -> queued，重试预算重置、历史记录保留')
else:
    assert http=='409' and d.get('error'), d
    print(f\"重试被阻断（HTTP {http}）：error={d.get('error')} detail={d.get('details') or d.get('detail')}\")"

echo "== 6. 恢复：orphaned 任务恢复 -> 成功或阻断原因透传 =="
RECOVER_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/agents/hermes-manager/reasoning-sessions/$SID_ORPHAN/recover" -o /tmp/smoke_d01_recover.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_d01_recover.json'))
http='$RECOVER_HTTP'
if http=='200':
    assert d['ok'], d
    print('恢复成功：session 已从 checkpoint 继续')
else:
    assert http=='409' and d.get('error'), d
    print(f\"恢复被阻断（HTTP {http}）：error={d.get('error')} detail={d.get('details') or d.get('detail')}\")"

echo "== 7. 生命周期控制未回归：runtime-status 仍暴露 availableActions，控制语义未动 =="
curl -sS "$BASE_URL/api/control/agents/hermes-manager/runtime-status" | python3 -c "
import json,sys
d=json.load(sys.stdin)
actions=((d.get('state') or {}).get('runtime') or {}).get('availableActions') or []
assert actions, d
print('availableActions =', actions)"

echo "== 8. 清理夹具后刷新：列表与服务端一致（夹具消失、无残留） =="
cleanup
trap - EXIT
curl -sS "$BASE_URL/api/control/queue/items" | python3 -c "
import json,sys
d=json.load(sys.stdin)
left=[i for i in d['items'] if i['sessionId'].startswith('smoke_d01_')]
assert not left, left
print('清理后列表无 smoke 夹具残留')"
echo "SMOKE PASS"
