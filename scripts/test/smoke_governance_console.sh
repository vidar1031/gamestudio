#!/usr/bin/env bash
# HERMES-H01 smoke：守护台治理闭环关键流程的可重复证据。
# 覆盖总计划 S3-05（查看一致性）与 S3-06（受控动作成功/阻断反馈 + 审计可追溯）：
#   - 待审核中心：waiting_review 任务集中呈现（review 详情 + 队列状态 join）
#   - 队列详情 artifact 证据索引
#   - 审核/重试/取消动作的成功或阻断反馈，且治理审计可追溯 sessionId/taskId
#   - 生命周期控制不回归（availableActions）
#   - console 治理页可编译访问
# 用法：先启动 control（sh restart_control.sh），再执行本脚本。
#   CONTROL_BASE_URL / CONSOLE_BASE_URL 可覆盖目标地址。
# 说明：脚本在真实 state/ 下写入 smoke_h01_ 前缀的夹具（session/queue item），
# 结束时全部清理；审计文件中 smoke_h01_ 记录同样清理。
set -euo pipefail

BASE_URL="${CONTROL_BASE_URL:-http://127.0.0.1:2099}"
CONSOLE_URL="${CONSOLE_BASE_URL:-http://127.0.0.1:8870}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION_DIR="$ROOT/state/agent-runtime-sessions"
QUEUE_DIR="$ROOT/state/reasoning-queue"
AUDIT_FILE="$ROOT/state/governance-audit.jsonl"

mkdir -p "$SESSION_DIR" "$QUEUE_DIR"

SID_REVIEW="smoke_h01_review"
SID_FAILED="smoke_h01_failed"

cleanup() {
  rm -f "$SESSION_DIR/$SID_REVIEW.json" "$SESSION_DIR/$SID_FAILED.json" \
        "$QUEUE_DIR/$SID_REVIEW.json" "$QUEUE_DIR/$SID_FAILED.json"
  if [ -f "$AUDIT_FILE" ]; then
    grep -v 'smoke_h01_' "$AUDIT_FILE" > "$AUDIT_FILE.tmp" 2>/dev/null || true
    mv "$AUDIT_FILE.tmp" "$AUDIT_FILE"
  fi
}
trap cleanup EXIT

echo "== 0. control server 健康检查 =="
curl -sS "$BASE_URL/api/health" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok'), d; print('ok:', d['service'])"

echo "== 1. 写入 smoke 夹具（waiting_review / failed 各一） =="
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
SID_REVIEW="$SID_REVIEW" SID_FAILED="$SID_FAILED" NOW="$NOW" \
SESSION_DIR="$SESSION_DIR" QUEUE_DIR="$QUEUE_DIR" node --input-type=module <<'EOF'
import fs from 'node:fs'
import path from 'node:path'
const { SID_REVIEW, SID_FAILED, NOW, SESSION_DIR, QUEUE_DIR } = process.env
const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2), 'utf8')
const makeSession = (sessionId, status, extra = {}) => ({
  sessionId, runtimeSessionId: sessionId, sessionKind: 'agent-runtime', agentId: 'hermes-manager',
  userPrompt: 'smoke 治理任务', title: `smoke 治理任务（${status}）`,
  submissionContext: { projectId: 'smoke_h01_proj' }, parentSessionId: null, childSessionIds: [],
  status, createdAt: NOW, updatedAt: NOW, runtimeTaskGraph: null,
  plan: { steps: [{ stepId: 's0', title: '生成故事草稿', action: 'write' }] },
  currentStepId: null, currentStepIndex: 0, review: extra.review || null,
  error: extra.error || null,
  events: [{ type: 'review_requested', title: '等待人工确认', summary: 'smoke 夹具', timestamp: NOW }],
  stateTransitions: [], artifacts: extra.artifacts || {}
})
const makeItem = (sessionId, status) => ({
  version: '1', taskId: sessionId, sessionId, projectId: 'smoke_h01_proj', status,
  claim: { workerId: null, claimedAt: null, claimGeneration: 0 },
  attempts: 1, recoveryCount: 0, resumeFromStep: null, lastError: null,
  retryCount: 0, nextAttemptAt: null, retryHistory: [],
  createdAt: NOW, updatedAt: NOW, startedAt: NOW, finishedAt: null,
  history: [{ from: null, to: status, reason: 'smoke_fixture', workerId: null, at: NOW }]
})
// waiting_review：待审核中心夹具（带 artifact 证据）
writeJson(SESSION_DIR, `${SID_REVIEW}.json`, makeSession(SID_REVIEW, 'waiting_review', {
  review: { title: '确认任务计划', summary: '计划包含 1 个步骤', targetType: 'plan', reviewPhase: 'standard', stepIndex: null, stepId: null },
  artifacts: { projectRoot: 'storage/projects/smoke_h01_proj', finalAnswer: 'smoke 最终回答预览内容' }
}))
writeJson(QUEUE_DIR, `${SID_REVIEW}.json`, makeItem(SID_REVIEW, 'running'))
// failed：受控动作反馈夹具（非等待审核 -> 审核阻断；failed -> 重试反馈）
writeJson(SESSION_DIR, `${SID_FAILED}.json`, makeSession(SID_FAILED, 'failed', { error: 'model_http_503' }))
writeJson(QUEUE_DIR, `${SID_FAILED}.json`, makeItem(SID_FAILED, 'failed'))
console.log('fixtures written')
EOF

echo "== 2. S3-05 待审核中心：waiting_review 任务集中呈现（review 详情 + 队列 join），failed 不出现 =="
curl -sS "$BASE_URL/api/control/reviews/pending" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
by_id={i['sessionId']:i for i in d['items']}
assert '$SID_REVIEW' in by_id, by_id.keys()
item=by_id['$SID_REVIEW']
assert item['review']['title']=='确认任务计划' and item['review']['targetType']=='plan', item
assert item['queueItem'] and item['queueItem']['status']=='running', item
assert item['projectId']=='smoke_h01_proj', item
assert '$SID_FAILED' not in by_id, by_id.keys()
print('待审核中心：review 详情、队列状态、projectId 均正确 join；非 waiting_review 任务已排除')"

echo "== 3. S3-05 队列详情：artifact 证据索引（项目目录 + 最终回答预览） =="
curl -sS "$BASE_URL/api/control/queue/items/$SID_REVIEW" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
arts=d['evidence']['artifacts']
assert arts['projectRoot']=='storage/projects/smoke_h01_proj', arts
assert arts['finalAnswerPreview']=='smoke 最终回答预览内容', arts
print('artifact 证据：projectRoot 与 finalAnswerPreview 均返回')"

echo "== 4. S3-06 审核动作：非等待审核任务审核 -> 409 阻断反馈 =="
REVIEW_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/agents/hermes-manager/reasoning-sessions/$SID_FAILED/review" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}' -o /tmp/smoke_h01_review.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_h01_review.json'))
assert '$REVIEW_HTTP'=='409' and d.get('error')=='reasoning_session_not_waiting_review', d
print('审核阻断反馈（HTTP 409）：error=reasoning_session_not_waiting_review')"

echo "== 5. S3-06 重试动作：failed 任务人工重试 -> 成功或阻断原因透传 =="
RETRY_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/agents/hermes-manager/reasoning-sessions/$SID_FAILED/retry" -o /tmp/smoke_h01_retry.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_h01_retry.json'))
http='$RETRY_HTTP'
if http=='200':
    assert d['ok'] and d['session']['status']=='queued', d
    print('重试成功：session -> queued')
else:
    assert http=='409' and d.get('error'), d
    print(f\"重试被阻断（HTTP {http}）：error={d.get('error')} detail={d.get('details') or d.get('detail')}\")"

echo "== 6. S3-06 取消动作 + 刷新一致：waiting_review 取消后不再出现在待审核中心 =="
curl -sS -X POST "$BASE_URL/api/control/agents/hermes-manager/reasoning-sessions/$SID_REVIEW/cancel" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'] and d['session']['status']=='cancelled', d
print('取消成功：session -> cancelled')"
curl -sS "$BASE_URL/api/control/reviews/pending" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ids=[i['sessionId'] for i in d['items']]
assert '$SID_REVIEW' not in ids, ids
print('刷新一致：已取消任务从待审核中心消失（服务端事实，非本地臆测）')"

echo "== 7. S3-06 治理审计：审核阻断 / 重试 / 取消动作均可追溯 sessionId =="
curl -sS "$BASE_URL/api/control/governance/audit" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
records=[r for r in d['records'] if (r.get('sessionId') or '').startswith('smoke_h01_')]
by=( lambda action, sid, result: any(r['action']==action and r['sessionId']==sid and r['result']==result for r in records) )
assert by('review', '$SID_FAILED', 'blocked'), records
assert by('cancel', '$SID_REVIEW', 'ok'), records
assert any(r['action']=='retry' and r['sessionId']=='$SID_FAILED' for r in records), records
print('审计追溯：review(blocked) / retry / cancel(ok) 三条记录齐全，均含 sessionId')"

echo "== 8. 生命周期控制未回归：runtime-status 仍暴露 availableActions =="
curl -sS "$BASE_URL/api/control/agents/hermes-manager/runtime-status" | python3 -c "
import json,sys
d=json.load(sys.stdin)
actions=((d.get('state') or {}).get('runtime') or {}).get('availableActions') or []
assert actions, d
print('availableActions =', actions)"

echo "== 9. console 治理页可编译访问（vite 按需编译 200） =="
curl -sS -o /dev/null -w 'console 首页 -> HTTP %{http_code}\n' "$CONSOLE_URL/"
curl -sS -o /dev/null -w 'GovernancePage 编译 -> HTTP %{http_code}\n' "$CONSOLE_URL/src/pages/GovernancePage.vue"

echo "== 10. 清理夹具后刷新：待审核中心与队列无残留 =="
cleanup
trap - EXIT
curl -sS "$BASE_URL/api/control/reviews/pending" | python3 -c "
import json,sys
d=json.load(sys.stdin)
left=[i for i in d['items'] if i['sessionId'].startswith('smoke_h01_')]
assert not left, left
print('清理后待审核中心无 smoke 夹具残留')"
echo "SMOKE PASS"
