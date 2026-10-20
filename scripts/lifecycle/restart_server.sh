#!/bin/bash
# 重启业务后端（仅 server，不动 editor）。从任意目录可调用：自定位仓根后委派 stop/start。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${ROOT}"

bash "${SCRIPT_DIR}/stop_server.sh" || true
sleep 1
bash "${SCRIPT_DIR}/start_server.sh"
