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

stop_pid() {
  local label="$1"
  local pid="$2"
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
      echo "${label}: force killed pid ${pid}"
    else
      echo "${label}: stopped pid ${pid}"
    fi
  else
    echo "${label}: process not running"
  fi
}

wait_for_port_free() {
  local label="$1"
  local port="$2"
  local max_attempts="${3:-20}"
  local attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if [ -z "$(listener_pid "${port}" || true)" ]; then
      echo "${label}: port :${port} released"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "${label}: port :${port} still busy" >&2
  return 1
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

wait_for_port_free "editor" 8868 || true
wait_for_port_free "server" 1999 || true

rm -f "${EDITOR_PID_FILE}" "${SERVER_PID_FILE}"
