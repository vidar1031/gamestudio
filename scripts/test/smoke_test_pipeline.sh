#!/usr/bin/env bash

set -euo pipefail

CONTROL_REPO="${LOCAL_AGENT_CONTROL_ROOT:-/Volumes/ovokit2t/aiwork/local-agent-control}"
CONTROL_SCRIPT="$CONTROL_REPO/scripts/test/control_production_test.mjs"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
TalkScene Control-First Smoke Test

用法:
  bash scripts/test/smoke_test_pipeline.sh [--help]

说明:
  守护台（control）已拆分至独立仓 local-agent-control，本脚本仅作转发入口。
  实际测试脚本：$LOCAL_AGENT_CONTROL_ROOT/scripts/test/control_production_test.mjs
EOF
  exit 0
fi

if [ ! -f "$CONTROL_SCRIPT" ]; then
  echo "缺少 control 测试脚本: $CONTROL_SCRIPT（守护台已拆分至 local-agent-control，请确认该仓库存在）" >&2
  exit 1
fi

echo "========================================"
echo "  TalkScene Control-First Smoke Test"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "  （经 local-agent-control 守护台执行）"
echo "========================================"
echo ""

exec node "$CONTROL_SCRIPT" "$@"
