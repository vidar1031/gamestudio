#!/bin/bash
set -euo pipefail

ROOT="/Users/zhanghongqin/work/game_studio"
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
echo "Health"
if curl -fsS http://127.0.0.1:1999/api/health >/dev/null 2>&1; then
  echo "server health: ok"
else
  echo "server health: fail"
fi

if curl -fsS http://localhost:8868 >/dev/null 2>&1; then
  echo "editor http: ok"
else
  echo "editor http: fail"
fi
