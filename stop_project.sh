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

stop_pid() {
  local label="$1"
  local pid="$2"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    echo "${label}: stopped pid ${pid}"
  else
    echo "${label}: process not running"
  fi
}

stop_from_pid_file() {
  local label="$1"
  local pid_file="$2"
  if [ ! -f "${pid_file}" ]; then
    echo "${label}: no pid file"
    return 0
  fi
  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  stop_pid "${label}" "${pid}"
  rm -f "${pid_file}"
}

EDITOR_PID="$(listener_pid 8868 || true)"
SERVER_PID="$(listener_pid 1999 || true)"

if [ -n "${EDITOR_PID}" ]; then
  stop_pid "editor" "${EDITOR_PID}"
fi
if [ -n "${SERVER_PID}" ]; then
  stop_pid "server" "${SERVER_PID}"
fi

rm -f "${EDITOR_PID_FILE}" "${SERVER_PID_FILE}"
