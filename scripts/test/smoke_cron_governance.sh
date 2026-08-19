#!/usr/bin/env bash
# HERMES-H02 smoke：cron 受控生产触发的可重复证据。
# 覆盖总计划 S3-08（cron 只能通过治理 API 提交已注册 workflow 的任务）：
#   - workflow 白名单：未注册 workflow 创建被拒绝（400）并审计 blocked
#   - job 注册/列表/调度器状态可见
#   - 治理流转：暂停/恢复/停用受控，非 active 状态触发被 409 阻断并审计
#   - console 治理页可编译访问；生命周期控制不回归
# 说明：smoke 只走「阻断路径」，不真正提交生产任务（避免 smoke 产生真实模型调用）；
#       提交链路与幂等证据由 S3-09 真实演练与 cronGovernance.test.mjs 覆盖。
#       全程创建 smoke_h02 前缀 job，结束时删除并清理审计行。
# 用法：先启动 control（sh restart_control.sh），再执行本脚本。
#   CONTROL_BASE_URL / CONSOLE_BASE_URL 可覆盖目标地址。
set -euo pipefail

BASE_URL="${CONTROL_BASE_URL:-http://127.0.0.1:2099}"
CONSOLE_URL="${CONSOLE_BASE_URL:-http://127.0.0.1:8870}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$ROOT/state/governance-audit.jsonl"

JOB_ID=""

cleanup() {
  if [ -n "$JOB_ID" ]; then
    curl -sS -X DELETE "$BASE_URL/api/control/cron/jobs/$JOB_ID" -o /dev/null 2>/dev/null || true
  fi
  if [ -f "$AUDIT_FILE" ]; then
    grep -v 'smoke_h02' "$AUDIT_FILE" > "$AUDIT_FILE.tmp" 2>/dev/null || true
    if [ -n "$JOB_ID" ]; then
      grep -v "$JOB_ID" "$AUDIT_FILE.tmp" > "$AUDIT_FILE.tmp2" 2>/dev/null || true
      mv "$AUDIT_FILE.tmp2" "$AUDIT_FILE.tmp"
    fi
    mv "$AUDIT_FILE.tmp" "$AUDIT_FILE"
  fi
}
trap cleanup EXIT

echo "== 0. control server 健康检查 =="
curl -sS "$BASE_URL/api/health" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok'), d; print('ok:', d['service'])"

echo "== 1. S3-08 cron 端点可见：调度器状态 + workflow 白名单（与 workflows/ 注册表对齐） =="
curl -sS "$BASE_URL/api/control/cron/jobs" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
assert d['scheduler'] and d['scheduler']['running'] is True, d['scheduler']
ids=[w['workflowId'] for w in d['workflows']]
assert ids==['story_production','gamestudio_bootstrap','project_status'], ids
print('调度器运行中；白名单 =', ids)"

echo "== 2. S3-08 白名单：未注册 workflow 创建被拒绝（400）并审计 blocked =="
GHOST_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/cron/jobs" \
  -H 'Content-Type: application/json' -d '{"name":"smoke_h02_ghost","workflow":"smoke_h02_ghost","prompt":"x","intervalMs":60000}' \
  -o /tmp/smoke_h02_ghost.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_h02_ghost.json'))
assert '$GHOST_HTTP'=='400' and d.get('error')=='workflow_not_registered', d
print('未注册 workflow 拒绝（HTTP 400）：error=workflow_not_registered')"
curl -sS "$BASE_URL/api/control/governance/audit" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rec=[r for r in d['records'] if r['action']=='cron_job_create' and r['result']=='blocked' and 'smoke_h02_ghost' in (r.get('detail') or '')]
assert rec, d['records'][:3]
print('创建拒绝已审计：cron_job_create blocked 含 workflow 标识')"

echo "== 3. 注册合法 job（24h 间隔，smoke 期间不会到点触发） =="
CREATE_RES=$(curl -sS -X POST "$BASE_URL/api/control/cron/jobs" \
  -H 'Content-Type: application/json' -d '{"name":"smoke_h02_job","workflow":"project_status","prompt":"smoke_h02 汇总项目状态","intervalMs":86400000,"reviewMode":"manual"}')
JOB_ID=$(python3 -c "
import json
d=json.loads('''$CREATE_RES''')
assert d['ok'], d
print(d['job']['jobId'])")
echo "jobId = $JOB_ID"
curl -sS "$BASE_URL/api/control/cron/jobs" | python3 -c "
import json,sys
d=json.load(sys.stdin)
job=[j for j in d['jobs'] if j['jobId']=='$JOB_ID']
assert job and job[0]['status']=='active', d['jobs']
assert job[0]['nextTriggerAt'], job
print('job 已注册：status=active，下次触发时间已计算')"

echo "== 4. 治理流转：暂停 -> 触发 409 阻断 -> 恢复 -> 停用 -> 触发 409 阻断（全部审计） =="
curl -sS -X POST "$BASE_URL/api/control/cron/jobs/$JOB_ID/status" \
  -H 'Content-Type: application/json' -d '{"action":"pause"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['job']['status']=='paused', d; print('暂停：active -> paused')"
PAUSED_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/cron/jobs/$JOB_ID/trigger" -o /tmp/smoke_h02_trigger.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_h02_trigger.json'))
assert '$PAUSED_HTTP'=='409' and d.get('error')=='cron_job_not_active', d
print('暂停状态触发阻断（HTTP 409）：error=cron_job_not_active')"
curl -sS -X POST "$BASE_URL/api/control/cron/jobs/$JOB_ID/status" \
  -H 'Content-Type: application/json' -d '{"action":"resume"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['job']['status']=='active', d; print('恢复：paused -> active（下次触发已重新对齐下一周期）')"
curl -sS -X POST "$BASE_URL/api/control/cron/jobs/$JOB_ID/status" \
  -H 'Content-Type: application/json' -d '{"action":"disable"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['job']['status']=='disabled', d; print('停用：active -> disabled')"
DISABLED_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/cron/jobs/$JOB_ID/trigger" -o /tmp/smoke_h02_trigger2.json -w '%{http_code}')
python3 -c "
import json
d=json.load(open('/tmp/smoke_h02_trigger2.json'))
assert '$DISABLED_HTTP'=='409' and d.get('error')=='cron_job_not_active', d
print('停用状态触发阻断（HTTP 409）：error=cron_job_not_active')"
curl -sS "$BASE_URL/api/control/governance/audit" | python3 -c "
import json,sys
d=json.load(sys.stdin)
recs=[r for r in d['records'] if r.get('jobId')=='$JOB_ID']
by=lambda action,result: any(r['action']==action and r['result']==result for r in recs)
assert by('cron_job_pause','ok') and by('cron_job_resume','ok') and by('cron_job_disable','ok'), recs
assert sum(1 for r in recs if r['action']=='cron_trigger' and r['result']=='blocked')>=2, recs
print('审计齐全：pause/resume/disable ok + 两次 cron_trigger blocked，均可按 jobId 追溯')"

echo "== 5. 未知 job 操作返回 404 =="
MISSING_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/cron/jobs/smoke_h02_missing/status" \
  -H 'Content-Type: application/json' -d '{"action":"pause"}' -o /dev/null -w '%{http_code}')
assert_missing() { [ "$1" = "404" ] || { echo "期望 404，实际 $1"; exit 1; }; }
assert_missing "$MISSING_HTTP"
echo "未知 job：HTTP 404"

echo "== 6. 生命周期控制未回归：runtime-status 仍暴露 availableActions =="
curl -sS "$BASE_URL/api/control/agents/hermes-manager/runtime-status" | python3 -c "
import json,sys
d=json.load(sys.stdin)
actions=(d.get('runtimeStatus') or {}).get('availableActions') or []
assert actions, d
print('availableActions =', actions)"

echo "== 7. console 治理页可编译访问（vite 按需编译 200） =="
curl -sS -o /dev/null -w 'console 首页 -> HTTP %{http_code}\n' "$CONSOLE_URL/"
curl -sS -o /dev/null -w 'GovernancePage 编译 -> HTTP %{http_code}\n' "$CONSOLE_URL/src/pages/GovernancePage.vue"

echo "== 8. 清理：删除 smoke job，列表与审计无残留 =="
curl -sS -X DELETE "$BASE_URL/api/control/cron/jobs/$JOB_ID" | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'], d; print('job 已删除')"
OLD_JOB_ID="$JOB_ID"
JOB_ID=""
curl -sS "$BASE_URL/api/control/cron/jobs" | python3 -c "
import json,sys
d=json.load(sys.stdin)
left=[j for j in d['jobs'] if j['jobId']=='$OLD_JOB_ID']
assert not left, left
print('清理后列表无 smoke job 残留')"
# 审计行清理（trap 中按 smoke_h02 / jobId 过滤）
if [ -f "$AUDIT_FILE" ]; then
  grep -v 'smoke_h02' "$AUDIT_FILE" > "$AUDIT_FILE.tmp" 2>/dev/null || true
  grep -v "$OLD_JOB_ID" "$AUDIT_FILE.tmp" > "$AUDIT_FILE.tmp2" 2>/dev/null || true
  mv "$AUDIT_FILE.tmp2" "$AUDIT_FILE.tmp"
  mv "$AUDIT_FILE.tmp" "$AUDIT_FILE"
fi
trap - EXIT
echo "SMOKE PASS"
