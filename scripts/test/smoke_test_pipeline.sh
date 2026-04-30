#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTROL_SCRIPT="$ROOT/scripts/test/control_production_test.mjs"

print_help() {
  cat <<'EOF'
GameStudio Control-First Smoke Test

用法:
  bash scripts/test/smoke_test_pipeline.sh [--help]

行为:
  1. 不再启动或检查 GameStudio server/editor 主链路
  2. 先检查 control 控制器
  3. 后续测试全部以 control 反馈为基准
  4. 实际执行委托给 scripts/test/control_production_test.mjs
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  print_help
  exit 0
fi

if [ ! -f "$CONTROL_SCRIPT" ]; then
  echo "缺少 control 测试脚本: $CONTROL_SCRIPT" >&2
  exit 1
fi

cd "$ROOT"

echo "========================================"
echo "  GameStudio Control-First Smoke Test"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
echo ""
echo "本脚本不再检查或启动 GameStudio server/editor。"
echo "测试将先检查 control 控制器，再通过 control 执行后续阶段。"
echo ""

exec node "$CONTROL_SCRIPT" "$@"
