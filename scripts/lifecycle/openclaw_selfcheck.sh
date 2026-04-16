#!/bin/bash
set -euo pipefail

OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"
OPENCLAW_HEALTH_URL="${OPENCLAW_HEALTH_URL:-http://127.0.0.1:${OPENCLAW_PORT}/api/health}"
MODEL_URL="${MODEL_URL:-http://127.0.0.1:18888/v1/models}"
MODEL_AUTH_TOKEN="${MODEL_AUTH_TOKEN:-omlx123}"

listener_pid() {
  local port="$1"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

gateway_ok=0
if curl --noproxy '*' -fsS --max-time 2 "${OPENCLAW_HEALTH_URL}" >/dev/null 2>&1; then
  gateway_ok=1
elif [ -n "$(listener_pid "${OPENCLAW_PORT}" || true)" ]; then
  # Some OpenClaw builds do not expose /api/health, but an open listener still means gateway is up.
  gateway_ok=1
fi

model_ok=0
if curl --noproxy '*' -fsS --max-time 3 -H "Authorization: Bearer ${MODEL_AUTH_TOKEN}" "${MODEL_URL}" 2>/dev/null | grep -q '"data"'; then
  model_ok=1
fi

if [ "${gateway_ok}" = "1" ]; then
  echo "openclaw gateway: ok"
else
  echo "openclaw gateway: fail"
fi

if [ "${model_ok}" = "1" ]; then
  echo "model service: ok"
else
  echo "model service: fail"
fi

if [ "${gateway_ok}" = "1" ] && [ "${model_ok}" = "1" ]; then
  exit 0
fi

exit 1
