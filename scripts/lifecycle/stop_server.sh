#!/bin/bash
set -euo pipefail

ROOT="."
SERVER_PORT="${PORT:-1999}"
RUN_DIR="${ROOT}/.run"
SERVER_PID_FILE="${RUN_DIR}/server.pid"

listener_pid() {
  local port="$1"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

stop_pid() {
  local pid="$1"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    echo "server: stopped pid ${pid}"
  else
    echo "server: process not running"
  fi
}

PID="$(listener_pid "${SERVER_PORT}" || true)"
if [ -z "${PID}" ] && [ -f "${SERVER_PID_FILE}" ]; then
  PID="$(cat "${SERVER_PID_FILE}" 2>/dev/null || true)"
fi

stop_pid "${PID}"
rm -f "${SERVER_PID_FILE}"
