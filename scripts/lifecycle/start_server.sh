#!/bin/bash
set -euo pipefail

ROOT="."
SERVER_WORKDIR="${ROOT}/apps/server"
SERVER_PORT="${PORT:-1999}"
RUN_DIR="${ROOT}/.run"
SERVER_LOG="${RUN_DIR}/server.log"
SERVER_PID_FILE="${RUN_DIR}/server.pid"

listener_pid() {
  local port="$1"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

spawn_detached() {
  local cmd="$1"
  local log_file="$2"
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -lc "cd '${ROOT}' && exec ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  else
    nohup bash -lc "cd '${ROOT}' && exec ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  fi
  echo $!
}

wait_for_server() {
  local url="http://127.0.0.1:${SERVER_PORT}/api/health"
  local max_attempts="${1:-30}"
  local attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if curl --noproxy '*' -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

wait_for_port_free() {
  local port="$1"
  local max_attempts="${2:-20}"
  local attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if [ -z "$(listener_pid "${port}" || true)" ]; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

stop_existing_server_if_needed() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return 0
  fi
  echo "ℹ️ server 已存在，执行自动重启: pid ${pid}"
  kill "${pid}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "${pid}" >/dev/null 2>&1; then
    kill -9 "${pid}" >/dev/null 2>&1 || true
  fi
  if ! wait_for_port_free "${SERVER_PORT}" 20; then
    echo "❌ server 端口 :${SERVER_PORT} 未释放，无法继续重启" >&2
    exit 1
  fi
  rm -f "${SERVER_PID_FILE}"
}

mkdir -p "${RUN_DIR}"

if [ ! -d "${ROOT}/node_modules" ]; then
  echo "❌ 未找到 ${ROOT}/node_modules，请先执行 npm install" >&2
  exit 1
fi

if [ ! -f "${SERVER_WORKDIR}/src/index.js" ]; then
  echo "❌ 未找到 ${SERVER_WORKDIR}/src/index.js" >&2
  exit 1
fi

EXISTING_PID="$(listener_pid "${SERVER_PORT}" || true)"
if [ -n "${EXISTING_PID}" ]; then
  stop_existing_server_if_needed "${EXISTING_PID}"
fi

echo "▶ 启动 server ..."
spawn_detached "bash -lc \"cd '${SERVER_WORKDIR}' && exec node src/index.js\"" "${SERVER_LOG}" >/dev/null

if ! wait_for_server 30; then
  echo "❌ server 未在预期时间内就绪，请检查日志: ${SERVER_LOG}" >&2
  exit 1
fi

SERVER_PID="$(listener_pid "${SERVER_PORT}" || true)"
if [ -n "${SERVER_PID}" ]; then
  echo "${SERVER_PID}" > "${SERVER_PID_FILE}"
fi

echo "✅ server 已启动: http://127.0.0.1:${SERVER_PORT}"
echo "PID: ${SERVER_PID:-unknown}"
echo "Log: ${SERVER_LOG}"
