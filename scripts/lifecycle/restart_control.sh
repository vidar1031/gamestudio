#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${ROOT}/.run"

CONTROL_SERVER_PORT="2099"
CONTROL_CONSOLE_PORT="8870"

CONTROL_SERVER_LOG="${RUN_DIR}/control-server.log"
CONTROL_CONSOLE_LOG="${RUN_DIR}/control-console.log"
CONTROL_SERVER_PID_FILE="${RUN_DIR}/control-server.pid"
CONTROL_CONSOLE_PID_FILE="${RUN_DIR}/control-console.pid"

listener_pid() {
  local port="$1"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
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

wait_for_http_ready() {
  local url="$1"
  local max_attempts="${2:-30}"
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

stop_listener_if_needed() {
  local name="$1"
  local port="$2"
  local pid_file="$3"
  local pid
  pid="$(listener_pid "${port}" || true)"

  if [ -n "${pid}" ]; then
    echo "ℹ️ ${name} 已运行，关闭旧进程: pid ${pid} (port ${port})"
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
    fi
  fi

  if ! wait_for_port_free "${port}" 20; then
    echo "❌ ${name} 端口 ${port} 未释放，无法继续重启" >&2
    exit 1
  fi

  rm -f "${pid_file}"
}

mkdir -p "${RUN_DIR}"

if [ ! -d "${ROOT}/node_modules" ]; then
  echo "❌ 未找到 ${ROOT}/node_modules，请先执行 npm install" >&2
  exit 1
fi

stop_listener_if_needed "control-server" "${CONTROL_SERVER_PORT}" "${CONTROL_SERVER_PID_FILE}"
stop_listener_if_needed "control-console" "${CONTROL_CONSOLE_PORT}" "${CONTROL_CONSOLE_PID_FILE}"

rm -f "${CONTROL_SERVER_LOG}" "${CONTROL_CONSOLE_LOG}"

echo "▶ 启动 control-server :${CONTROL_SERVER_PORT}"
spawn_detached "env CONTROL_SERVER_PORT='${CONTROL_SERVER_PORT}' npm --workspace @game-studio/control-server run dev" "${CONTROL_SERVER_LOG}" >/dev/null

if ! wait_for_http_ready "http://127.0.0.1:${CONTROL_SERVER_PORT}/api/health" 30; then
  echo "❌ control-server 未在预期时间内就绪，请检查日志: ${CONTROL_SERVER_LOG}" >&2
  exit 1
fi

SERVER_PID="$(listener_pid "${CONTROL_SERVER_PORT}" || true)"
if [ -n "${SERVER_PID}" ]; then
  echo "${SERVER_PID}" > "${CONTROL_SERVER_PID_FILE}"
fi

echo "▶ 启动 control-console :${CONTROL_CONSOLE_PORT}"
spawn_detached "env CONTROL_SERVER_ORIGIN='http://127.0.0.1:${CONTROL_SERVER_PORT}' npm --workspace @game-studio/control-console run dev -- --host 0.0.0.0 --port ${CONTROL_CONSOLE_PORT} --strictPort" "${CONTROL_CONSOLE_LOG}" >/dev/null

if ! wait_for_http_ready "http://127.0.0.1:${CONTROL_CONSOLE_PORT}" 30; then
  echo "❌ control-console 未在预期时间内就绪，请检查日志: ${CONTROL_CONSOLE_LOG}" >&2
  exit 1
fi

CONSOLE_PID="$(listener_pid "${CONTROL_CONSOLE_PORT}" || true)"
if [ -n "${CONSOLE_PID}" ]; then
  echo "${CONSOLE_PID}" > "${CONTROL_CONSOLE_PID_FILE}"
fi

echo "✅ apps/control 已完成重启"
echo "server : http://127.0.0.1:${CONTROL_SERVER_PORT}"
echo "console: http://127.0.0.1:${CONTROL_CONSOLE_PORT}"
echo "logs   : ${CONTROL_SERVER_LOG}, ${CONTROL_CONSOLE_LOG}"