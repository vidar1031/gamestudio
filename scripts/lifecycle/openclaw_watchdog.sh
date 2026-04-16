#!/bin/bash
set -euo pipefail

PROJECT_DIR="/Volumes/ovokit2t/aiwork/gamestudio"
SELF_CHECK_SCRIPT="${PROJECT_DIR}/scripts/lifecycle/openclaw_selfcheck.sh"
OPENCLAW_APP="${OPENCLAW_APP:-/Volumes/ovokit2t/AIOVO/openclaw/OpenClaw.app}"
RUN_DIR="${PROJECT_DIR}/.run"
STATE_FILE="${RUN_DIR}/openclaw_watchdog.state"
TIMEOUT_SECONDS="${WATCHDOG_TIMEOUT_SECONDS:-600}"
RECOVERY_COOLDOWN_SECONDS="${WATCHDOG_RECOVERY_COOLDOWN_SECONDS:-300}"

mkdir -p "${RUN_DIR}"

FAILURE_SINCE=0
LAST_RECOVERY=0
if [ -f "${STATE_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${STATE_FILE}" || true
fi

now="$(date +%s)"

write_state() {
  cat > "${STATE_FILE}" <<EOF
FAILURE_SINCE=${FAILURE_SINCE}
LAST_RECOVERY=${LAST_RECOVERY}
EOF
}

if bash "${SELF_CHECK_SCRIPT}" >/dev/null 2>&1; then
  if [ "${FAILURE_SINCE}" -ne 0 ]; then
    echo "[watchdog] self-check recovered"
  fi
  FAILURE_SINCE=0
  write_state
  exit 0
fi

if [ "${FAILURE_SINCE}" -eq 0 ]; then
  FAILURE_SINCE="${now}"
fi

elapsed=$((now - FAILURE_SINCE))
echo "[watchdog] self-check failed for ${elapsed}s"

if [ "${elapsed}" -lt "${TIMEOUT_SECONDS}" ]; then
  write_state
  exit 0
fi

if [ "${LAST_RECOVERY}" -ne 0 ] && [ $((now - LAST_RECOVERY)) -lt "${RECOVERY_COOLDOWN_SECONDS}" ]; then
  echo "[watchdog] recovery cooldown active, skip this cycle"
  write_state
  exit 0
fi

echo "[watchdog] timeout reached (${TIMEOUT_SECONDS}s), attempting recovery"

# Try to relaunch OpenClaw app.
pkill -f "OpenClaw" >/dev/null 2>&1 || true
if [ -d "${OPENCLAW_APP}" ]; then
  open "${OPENCLAW_APP}" >/dev/null 2>&1 || true
else
  open -a OpenClaw >/dev/null 2>&1 || true
fi

# Re-run local report tasks so the user can see system state after recovery.
bash "${PROJECT_DIR}/scripts/lifecycle/reporter.sh" >/tmp/openclaw_watchdog_report.log 2>&1 || true
bash "${PROJECT_DIR}/scripts/lifecycle/reporter_email.sh" >/tmp/openclaw_watchdog_email.log 2>&1 || true

LAST_RECOVERY="${now}"
FAILURE_SINCE="${now}"
write_state

echo "[watchdog] recovery triggered"
