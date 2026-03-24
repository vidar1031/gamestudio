#!/bin/bash
set -euo pipefail

ROOT="/Users/zhanghongqin/work/game_studio"

usage() {
  cat <<EOF
Usage:
  ./restart_project.sh              # stop then foreground start
  ./restart_project.sh --detached   # stop then background start
EOF
}

MODE_ARG=""
case "${1:-}" in
  "" )
    ;;
  --detached )
    MODE_ARG="--detached"
    ;;
  -h|--help )
    usage
    exit 0
    ;;
  * )
    echo "Unknown argument: ${1}" >&2
    usage >&2
    exit 1
    ;;
esac

cd "${ROOT}"

echo "Stopping Game Studio..."
bash "./stop_project.sh" || true

echo "Starting Game Studio..."
if [ -n "${MODE_ARG}" ]; then
  bash "./start_project.sh" "${MODE_ARG}" || exit $?
else
  bash "./start_project.sh" || exit $?
fi

echo "Restart complete."

