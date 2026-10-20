#!/bin/bash
# 全栈启动：OMLX 检测 -> TalkScene(server+editor) -> Control(control-server+console)
# 每步失败即停；OMLX 是外部独立服务，本脚本只检测不代管。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

OMLX_BASE_URL="${LOCALOXML_BASE_URL:-http://127.0.0.1:18888/v1}"
# /v1/models 需要 API key，健康检查走无需鉴权的 /health
OMLX_HEALTH_URL="${OMLX_BASE_URL%/v1}/health"
SERVER_URL="http://127.0.0.1:1999"
EDITOR_URL="http://localhost:8868"
CONTROL_SERVER_URL="http://127.0.0.1:2099"
CONTROL_CONSOLE_URL="http://127.0.0.1:8870"

usage() {
  cat <<EOF
Usage:
  bash scripts/lifecycle/start_full_stack.sh              # 检测 OMLX 并按顺序启动全栈
  bash scripts/lifecycle/start_full_stack.sh --skip-omlx  # 跳过 OMLX 检测（仅启动服务，AI 生成将不可用）
EOF
}

SKIP_OMLX=0
case "${1:-}" in
  "" ) ;;
  --skip-omlx ) SKIP_OMLX=1 ;;
  -h|--help ) usage; exit 0 ;;
  * ) echo "Unknown argument: ${1}" >&2; usage >&2; exit 1 ;;
esac

http_ok() {
  curl --noproxy '*' -fsS -m 5 "$1" >/dev/null 2>&1
}

echo "=========================================="
echo "   TalkScene Full-Stack Launcher"
echo "=========================================="

echo "▶ [1/3] 检测 OMLX 本地模型服务: ${OMLX_BASE_URL}"
if [ "${SKIP_OMLX}" = "1" ]; then
  echo "⚠️  已跳过 OMLX 检测；story 生产的 AI 生成步骤将显式失败"
elif http_ok "${OMLX_HEALTH_URL}"; then
  echo "✅ OMLX 就绪"
else
  echo "❌ OMLX 未就绪: ${OMLX_HEALTH_URL} 无响应" >&2
  echo "   OMLX 是独立服务，请先手动启动（加载模型后）再执行本脚本；" >&2
  echo "   如确认暂时不需要 AI 生成，可使用 --skip-omlx 仅启动服务。" >&2
  exit 1
fi

echo ""
echo "▶ [2/3] 启动 TalkScene Server + Editor"
bash "${ROOT}/scripts/lifecycle/start_project.sh" --detached

echo ""
echo "▶ [3/3] 启动 Control Server + Console"
bash "${ROOT}/scripts/lifecycle/restart_control.sh"

echo ""
echo "=========================================="
echo "   全栈状态汇总"
echo "=========================================="
check() {
  local label="$1" url="$2"
  if http_ok "${url}"; then
    echo "✅ ${label}: ${url}"
  else
    echo "❌ ${label}: ${url} 未就绪"
    return 1
  fi
}

FAILED=0
check "OMLX            " "${OMLX_HEALTH_URL}" || [ "${SKIP_OMLX}" = "1" ] || FAILED=1
check "TalkScene Server" "${SERVER_URL}/api/health" || FAILED=1
check "TalkScene Editor" "${EDITOR_URL}" || FAILED=1
check "Control Server  " "${CONTROL_SERVER_URL}/api/health" || FAILED=1
check "Control Console " "${CONTROL_CONSOLE_URL}" || FAILED=1

if [ "${FAILED}" = "1" ]; then
  echo ""
  echo "❌ 存在未就绪服务，请查看 .run/ 下对应日志" >&2
  exit 1
fi

echo ""
echo "✅ 全栈启动完成。下一步可用: node scripts/test/e2e_story_production.mjs 发起真实生产验证"
