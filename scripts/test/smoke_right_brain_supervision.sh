#!/usr/bin/env bash
# HERMES-H03 smoke：右脑子 agent 受控监察的可重复证据。
# 覆盖总计划 S3-10（右脑子 agent 只能读取健康/证据、提出建议或调用已注册受控动作；越权被拒绝且审计）：
#   - 身份/能力白名单/右脑模型可用性如实呈现（可用或显式 unavailableReason）
#   - 真实触发一次监察：当前 MOONSHOT_API_KEY（Kimi）401 失效，预期显式降级
#     （model_unavailable / model_error），留证不伪造；若 key 恢复有效则为 completed
#   - 审核端点错误形状（未知记录 404）；越权拦截审计动作已注册
#   - console 治理页可编译访问；生命周期控制不回归
# 说明：smoke 产生的监察运行记录在结束时清理（state/right-brain-supervision.json 按 runId 过滤），
#       审计行按 runId 清理；白名单放行/越权拒绝/审核执行链路由 rightBrainSupervision.test.mjs 覆盖。
# 用法：先启动 control（sh restart_control.sh），再执行本脚本。
#   CONTROL_BASE_URL / CONSOLE_BASE_URL 可覆盖目标地址。
set -euo pipefail

BASE_URL="${CONTROL_BASE_URL:-http://127.0.0.1:2099}"
CONSOLE_URL="${CONSOLE_BASE_URL:-http://127.0.0.1:8870}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$ROOT/state/governance-audit.jsonl"
SUPERVISION_FILE="$ROOT/state/right-brain-supervision.json"

RUN_ID=""

cleanup() {
  if [ -n "$RUN_ID" ] && [ -f "$SUPERVISION_FILE" ]; then
    python3 - "$SUPERVISION_FILE" "$RUN_ID" <<'PY' || true
import json, sys
file, run_id = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(file))
    data['runs'] = [r for r in data.get('runs', []) if r.get('runId') != run_id]
    json.dump(data, open(file, 'w'), ensure_ascii=False, indent=2)
except Exception:
    pass
PY
  fi
  if [ -n "$RUN_ID" ] && [ -f "$AUDIT_FILE" ]; then
    grep -v "$RUN_ID" "$AUDIT_FILE" > "$AUDIT_FILE.tmp" 2>/dev/null || true
    mv "$AUDIT_FILE.tmp" "$AUDIT_FILE"
  fi
}
trap cleanup EXIT

echo "== 0. control server 健康检查 =="
curl -sS "$BASE_URL/api/health" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok'), d; print('ok:', d['service'])"

echo "== 1. S3-10 监察端点可见：固定身份 + 只读/受控白名单 + 模型可用性如实报告 =="
curl -sS "$BASE_URL/api/control/supervision/right-brain" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['ok'], d
sup=d['supervisor']
assert sup['supervisorId']=='hermes-right-brain-supervisor', sup
read_actions=[a['action'] for a in sup['readActions']]
assert 'story_inspect_project' in read_actions, read_actions
assert 'edit_workspace_file' not in read_actions, read_actions
controlled=[a['action'] for a in sup['controlledActions']]
assert controlled==['retry_session','cancel_session'], controlled
model=sup['model']
if model['available']:
    print('右脑模型可用：%s / %s' % (model['provider'], model['model']))
else:
    assert model['unavailableReason'], model
    print('右脑模型显式不可用：%s（provider=%s model=%s）' % (model['unavailableReason'], model['provider'], model['model']))
print('只读白名单 %d 项；受控动作 %s' % (len(read_actions), controlled))"

echo "== 2. S3-10 真实触发一次监察：显式降级或完成，均留证不伪造 =="
RUN_RES=$(curl -sS -X POST "$BASE_URL/api/control/supervision/right-brain/run" \
  -H 'Content-Type: application/json' -d '{}')
RUN_ID=$(python3 -c "
import json
d=json.loads('''$RUN_RES''')
assert d['ok'], d
run=d['run']
assert run['supervisorId']=='hermes-right-brain-supervisor', run
assert run['status'] in ('completed','model_unavailable','model_error','output_invalid','evidence_unavailable'), run['status']
assert run['runId'], run
print(run['runId'])")
python3 -c "
import json
d=json.loads('''$RUN_RES''')
run=d['run']
status=run['status']
if status=='completed':
    print('监察完成：findings=%d suggestions=%d（模型真实产出）' % (len(run['findings']), len(run['suggestions'])))
else:
    assert run.get('error'), run
    assert run['suggestions']==[] and run['findings']==[], run
    print('显式降级（不伪造结果）：status=%s error=%s' % (status, run['error']))
print('runId =', run['runId'])"

echo "== 3. 治理审计留证：right_brain_supervision 记录可按 runId 追溯 =="
curl -sS "$BASE_URL/api/control/governance/audit" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rec=[r for r in d['records'] if r['action']=='right_brain_supervision' and '$RUN_ID' in (r.get('detail') or '')]
assert rec, d['records'][:3]
print('监察审计已留证：action=right_brain_supervision result=%s' % rec[0]['result'])"

echo "== 4. 审核端点错误形状：未知记录 404 =="
MISSING_HTTP=$(curl -sS -X POST "$BASE_URL/api/control/supervision/right-brain/runs/smoke_h03_missing/suggestions/s1/review" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}' -o /dev/null -w '%{http_code}')
[ "$MISSING_HTTP" = "404" ] || { echo "期望 404，实际 $MISSING_HTTP"; exit 1; }
echo "未知监察记录审核：HTTP 404"

echo "== 5. 生命周期控制未回归：runtime-status 仍暴露 availableActions =="
curl -sS "$BASE_URL/api/control/agents/hermes-manager/runtime-status" | python3 -c "
import json,sys
d=json.load(sys.stdin)
actions=(d.get('runtimeStatus') or {}).get('availableActions') or []
assert actions, d
print('availableActions =', actions)"

echo "== 6. console 治理页可编译访问（vite 按需编译 200） =="
curl -sS -o /dev/null -w 'console 首页 -> HTTP %{http_code}\n' "$CONSOLE_URL/"
curl -sS -o /dev/null -w 'GovernancePage 编译 -> HTTP %{http_code}\n' "$CONSOLE_URL/src/pages/GovernancePage.vue"

echo "== 7. 清理：监察运行记录与审计行无残留 =="
curl -sS "$BASE_URL/api/control/supervision/right-brain" | python3 -c "
import json,sys
d=json.load(sys.stdin)
left=[r for r in d['runs'] if r['runId']=='$RUN_ID']
# 清理在 trap 中执行，这里只确认记录当前可读回
assert len(left)==1, d['runs']
print('监察记录可读回（清理由退出钩子执行）')"
echo "SMOKE PASS"
