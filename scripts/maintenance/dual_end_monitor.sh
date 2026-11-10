#!/bin/bash
# 双端常时监控（2026-11-09 用户授权常开）：TalkScene + 守护台健康与调度异常一屏检查。
# 只读探测，不做修复——修复动作由调用方（agent）按矩阵执行。
# 输出：<check>:<ok|warn|fail>:<detail>；末尾 MONITOR_SUMMARY: ok|attention
set -uo pipefail

TS_SERVER="http://127.0.0.1:1999"
TS_EDITOR="http://localhost:8868"
CTL_SERVER="http://127.0.0.1:2099"
CTL_CONSOLE="http://127.0.0.1:8870"
COMFY="http://127.0.0.1:8188"
ROOT="/Volumes/ovokit2t/aiwork/talkscene"
ATTENTION=0

note() { # $1=check $2=status $3=detail
  echo "$1:$2:$3"
  [ "$2" != "ok" ] && ATTENTION=1
  return 0
}

http_code() { curl -sS -m "${3:-4}" -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || echo "000"; }

# 1) TalkScene server
code=$(http_code "$TS_SERVER/api/health")
[ "$code" = "200" ] && note "ts_server" "ok" "pid $(cat "$ROOT/.run/server.pid" 2>/dev/null || echo '?')" || note "ts_server" "fail" "http_$code"

# 2) Editor
code=$(http_code "$TS_EDITOR")
[ "$code" = "200" ] && note "ts_editor" "ok" ":8868" || note "ts_editor" "fail" "http_$code"

# 3) Control server
code=$(http_code "$CTL_SERVER/api/health")
[ "$code" = "200" ] && note "ctl_server" "ok" ":2099" || note "ctl_server" "fail" "http_$code"

# 4) Control console
code=$(http_code "$CTL_CONSOLE")
[ "$code" = "200" ] && note "ctl_console" "ok" ":8870" || note "ctl_console" "fail" "http_$code"

# 5) 调度器状态（排队/换模/阻断/内存）
state=$(curl -sS -m 6 "$CTL_SERVER/api/control/resources/state" 2>/dev/null)
if [ -z "$state" ]; then
  note "scheduler" "fail" "state_unreachable"
else
  echo "$state" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const r=JSON.parse(d)
  const queue=(r.llmQueue||[]).length+(r.exclusiveQueue||[]).length
  const swap=Boolean(r.swapInFlight)
  const blocked=r.blocked?String(r.blocked.reason||r.blocked.detail||'blocked'):''
  const online=(r.modelOnline?.otherLoaded||[]).concat(r.modelOnline?.loaded?[r.modelOnline.configuredModel]:[]).filter(Boolean)
  const waiters=(r.llmQueue||[]).map(w=>({pos:w.position,holder:String(w.holder||'').slice(-40),since:Date.parse(w.enqueuedAt||'')}))
  const now=Date.now()
  const stale=waiters.filter(w=>Number.isFinite(w.since)&&now-w.since>15*60*1000)
  let status='ok'
  const parts=[]
  parts.push('state='+r.state, 'queue='+queue, 'swap='+swap, 'online=['+online.join(',')+']')
  if (blocked) { status='warn'; parts.push('blocked:'+blocked) }
  if (stale.length) { status='warn'; parts.push('stale_waiters:'+stale.map(w=>'#'+w.pos).join(',')) }
  if (swap) parts.push('模型切换中')
  console.log('scheduler:'+status+':'+parts.join(' '))
})" || note "scheduler" "warn" "state_parse_failed"
fi

# 6) ComfyUI（仅当有图像类任务在跑/排队时才判 fail，否则空闲下线属正常）
code=$(http_code "$COMFY/system_stats" 3)
gpu_busy=$(echo "$state" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const q=(r.exclusiveQueue||[]).length+(r.gpuHolder?1:0);console.log(q)})" 2>/dev/null || echo 0)
if [ "$code" = "200" ]; then
  note "comfyui" "ok" "online"
elif [ "${gpu_busy:-0}" != "0" ]; then
  note "comfyui" "fail" "down_but_gpu_work_queued($gpu_busy)"
else
  note "comfyui" "ok" "idle_down（无图像任务，属正常）"
fi

# 7) AI 任务台账异常（运行超 30 分钟未更新 / 近期失败）
tasks=$(curl -sS -m 5 "$TS_SERVER/api/ai/tasks?includeDone=0" 2>/dev/null)
if [ -z "$tasks" ]; then
  note "ai_tasks" "warn" "tasks_unreachable"
else
  echo "$tasks" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const r=JSON.parse(d)
  const now=Date.now()
  const running=(r.tasks||[]).filter(t=>!t.done)
  const stuck=running.filter(t=>{const u=Date.parse(t.updatedAt||t.createdAt||'');return Number.isFinite(u)&&now-u>30*60*1000})
  const leases=(r.leaseStatuses||[]).length
  const parts=['running:'+running.length,'lease:'+leases]
  if (stuck.length) { console.log('ai_tasks:warn:stuck>'+stuck.map(t=>t.kind+'('+t.taskId+')').join(',')+' '+parts.join(' ')); return }
  console.log('ai_tasks:ok:'+parts.join(' '))
})" || note "ai_tasks" "warn" "tasks_parse_failed"
fi

# 8) server.log 近期严重错误（租约拒绝/内存护栏/500 风暴）
if [ -f "$ROOT/.run/server.log" ]; then
  recent=$(tail -80 "$ROOT/.run/server.log" | grep -cE "resource_lease_denied|prefill_memory|prefill guard|-> 500" || true)
  [ "${recent:-0}" -gt 3 ] && note "server_log" "warn" "近80行严重错误 x$recent" || note "server_log" "ok" "近期严重错误 $recent 条"
fi

echo "MONITOR_SUMMARY: $([ "$ATTENTION" = "0" ] && echo ok || echo attention)"
