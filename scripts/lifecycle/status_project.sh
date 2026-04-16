#!/bin/bash
set -euo pipefail

ROOT="."
RUN_DIR="${ROOT}/.run"
SERVER_PID_FILE="${RUN_DIR}/server.pid"
EDITOR_PID_FILE="${RUN_DIR}/editor.pid"

listener_pid() {
  local port="$1"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

print_port_state() {
  local label="$1"
  local port="$2"
  local pid
  pid="$(listener_pid "${port}" || true)"
  if [ -n "${pid}" ]; then
    echo "${label}: running on :${port} (pid ${pid})"
  else
    echo "${label}: not listening on :${port}"
  fi
}

echo "Game Studio status"
print_port_state "server" 1999
print_port_state "editor" 8868

echo ""
echo "Reporter schedule"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.gamestudio.reporter.plist"
if [ -f "${PLIST_PATH}" ] && launchctl print "gui/$(id -u)/com.gamestudio.reporter" >/dev/null 2>&1; then
  INTERVAL="$(/usr/libexec/PlistBuddy -c 'Print :StartInterval' "${PLIST_PATH}" 2>/dev/null || true)"
  if [ -n "${INTERVAL}" ]; then
    HOURS=$((INTERVAL / 3600))
    echo "reporter schedule: loaded (every ${INTERVAL}s ~ ${HOURS}h)"
  else
    echo "reporter schedule: loaded (calendar-based or custom)"
  fi
else
  echo "reporter schedule: not loaded"
fi

echo ""
echo "OpenClaw watchdog"
WATCHDOG_PLIST_PATH="${HOME}/Library/LaunchAgents/com.gamestudio.openclaw-watchdog.plist"
if [ -f "${WATCHDOG_PLIST_PATH}" ] && launchctl print "gui/$(id -u)/com.gamestudio.openclaw-watchdog" >/dev/null 2>&1; then
  INTERVAL="$(/usr/libexec/PlistBuddy -c 'Print :StartInterval' "${WATCHDOG_PLIST_PATH}" 2>/dev/null || true)"
  if [ -n "${INTERVAL}" ]; then
    echo "openclaw watchdog: loaded (every ${INTERVAL}s)"
  else
    echo "openclaw watchdog: loaded"
  fi
else
  echo "openclaw watchdog: not loaded"
fi

echo ""
echo "Health"
if curl --noproxy '*' -fsS http://127.0.0.1:1999/api/health >/dev/null 2>&1; then
  echo "server health: ok"
else
  echo "server health: fail"
fi

if curl --noproxy '*' -fsS http://localhost:8868 >/dev/null 2>&1; then
  echo "editor http: ok"
else
  echo "editor http: fail"
fi

if bash scripts/lifecycle/openclaw_selfcheck.sh >/dev/null 2>&1; then
  echo "openclaw/model health: ok"
else
  echo "openclaw/model health: fail"
fi
