#!/bin/bash
# 重启整个项目（server + editor）。从任意目录可调用：自定位仓根后委派 stop/start。
# 用法同 start_project.sh：./restart_project.sh [--detached]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${ROOT}"

bash "${SCRIPT_DIR}/stop_project.sh" || true
sleep 1
exec bash "${SCRIPT_DIR}/start_project.sh" "$@"
