#!/bin/bash
set -euo pipefail

ROOT="."
SERVER_PORT="${PORT:-1999}"
EDITOR_PORT="${VITE_PORT:-8868}"
SERVER_PID=""
DETACHED=0
RUN_DIR="${ROOT}/.run"
SERVER_LOG="${RUN_DIR}/server.log"
EDITOR_LOG="${RUN_DIR}/editor.log"
SERVER_PID_FILE="${RUN_DIR}/server.pid"
EDITOR_PID_FILE="${RUN_DIR}/editor.pid"
RESTARTED=0

usage() {
  cat <<EOF
Usage:
  ./start_project.sh              # foreground dev mode
  ./start_project.sh --detached   # background mode for agents/automation
EOF
}

case "${1:-}" in
  "" )
    ;;
  --detached )
    DETACHED=1
    ;;
  -h|--help )
    usage
    exit 0
    ;;
  * )
    echo "Unknown argument: ${1}" >&2
    usage >&2
    exit 1
    ;;
esac

mkdir -p "${RUN_DIR}"

ensure_local_dependencies() {
  if [ ! -d "${ROOT}/node_modules" ]; then
    echo "❌ 未找到 ${ROOT}/node_modules，无法构建 workspace 包" >&2
    echo "请先在仓库根目录执行: npm install" >&2
    exit 1
  fi

  if [ ! -x "${ROOT}/node_modules/.bin/tsc" ]; then
    echo "❌ 未找到本地 TypeScript 编译器: ${ROOT}/node_modules/.bin/tsc" >&2
    echo "当前启动流程会先执行 npm run build:packages；请先执行: npm install" >&2
    exit 1
  fi
}

is_pid_running() {
  local pid_file="$1"
  if [ ! -f "${pid_file}" ]; then
    return 1
  fi
  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  if [ -z "${pid}" ]; then
    return 1
  fi
  kill -0 "${pid}" >/dev/null 2>&1
}

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

wait_for_http() {
  local url="$1"
  local label="$2"
  local max_attempts="${3:-30}"
  local attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if curl --noproxy '*' -fsS "${url}" >/dev/null 2>&1; then
      echo "✅ ${label} 就绪: ${url}"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "❌ ${label} 未在预期时间内就绪: ${url}" >&2
  return 1
}

http_ready() {
  local url="$1"
  curl --noproxy '*' -fsS "${url}" >/dev/null 2>&1
}

wait_for_port_free() {
  local port="$1"
  local label="$2"
  local max_attempts="${3:-20}"
  local attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if [ -z "$(listener_pid "${port}" || true)" ]; then
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "❌ ${label} 端口 :${port} 未在预期时间内释放" >&2
  return 1
}

stop_listener_if_needed() {
  local label="$1"
  local port="$2"
  local pid
  pid="$(listener_pid "${port}" || true)"
  if [ -z "${pid}" ]; then
    return 0
  fi
  echo "ℹ️  检测到 ${label} 已存在，准备重启（pid ${pid}）"
  kill "${pid}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "${pid}" >/dev/null 2>&1; then
    echo "⚠️  ${label} 未响应 SIGTERM，执行强制结束（pid ${pid}）"
    kill -9 "${pid}" >/dev/null 2>&1 || true
  fi
  wait_for_port_free "${port}" "${label}" 20
}

restart_existing_services_if_needed() {
  local server_pid
  local editor_pid
  local server_ok=0
  local editor_ok=0
  server_pid="$(listener_pid "${SERVER_PORT}" || true)"
  editor_pid="$(listener_pid "${EDITOR_PORT}" || true)"
  if [ -n "${server_pid}" ]; then
    echo "${server_pid}" > "${SERVER_PID_FILE}"
    if http_ready "http://127.0.0.1:${SERVER_PORT}/api/health"; then
      server_ok=1
    fi
  fi
  if [ -n "${editor_pid}" ]; then
    echo "${editor_pid}" > "${EDITOR_PID_FILE}"
    if http_ready "http://localhost:${EDITOR_PORT}"; then
      editor_ok=1
    fi
  fi
  if [ -z "${server_pid}" ] && [ -z "${editor_pid}" ]; then
    return 0
  fi
  if [ "${server_ok}" = "1" ] && [ "${editor_ok}" = "1" ]; then
    echo "ℹ️  Game Studio 已在运行，按要求执行自动重启"
  else
    echo "ℹ️  检测到旧的或异常的 Game Studio 进程，执行自动清理后重启"
  fi
  RESTARTED=1
  stop_listener_if_needed "server" "${SERVER_PORT}"
  stop_listener_if_needed "editor" "${EDITOR_PORT}"
  rm -f "${SERVER_PID_FILE}" "${EDITOR_PID_FILE}"
}

cleanup() {
  if [ "${DETACHED}" = "1" ]; then
    return
  fi
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "${ROOT}"

echo "=========================================="
echo "   Game Studio Dev Launcher"
echo "=========================================="
echo ""
echo "Workspace: ${ROOT}"
echo "Server:    http://localhost:${SERVER_PORT}"
echo "Editor:    http://localhost:${EDITOR_PORT}"
if [ "${DETACHED}" = "1" ]; then
  echo "Mode:      detached"
else
  echo "Mode:      foreground"
fi
echo ""

ensure_local_dependencies

echo "▶ 构建 packages ..."
npm run build:packages
echo ""

restart_existing_services_if_needed

if [ "${DETACHED}" = "1" ]; then
  echo "▶ 后台启动 server ..."
  SERVER_PID="$(spawn_detached "npm run dev:server" "${SERVER_LOG}")"
  sleep 2

  echo "▶ 后台启动 editor ..."
  EDITOR_PID="$(spawn_detached "npm run dev:editor" "${EDITOR_LOG}")"

  wait_for_http "http://127.0.0.1:${SERVER_PORT}/api/health" "server" 30
  wait_for_http "http://localhost:${EDITOR_PORT}" "editor" 30

  listener_pid "${SERVER_PORT}" > "${SERVER_PID_FILE}"
  listener_pid "${EDITOR_PORT}" > "${EDITOR_PID_FILE}"

  echo ""
  echo "✅ Detached launcher finished"
  if [ "${RESTARTED}" = "1" ]; then
    echo "Mode note: auto-restarted existing server/editor"
  fi
  echo "Server PID: $(cat "${SERVER_PID_FILE}" 2>/dev/null || echo unknown)"
  echo "Editor PID: $(cat "${EDITOR_PID_FILE}" 2>/dev/null || echo unknown)"
  echo "Server log: ${SERVER_LOG}"
  echo "Editor log: ${EDITOR_LOG}"
  exit 0
fi

echo "▶ 启动 server ..."
npm run dev:server &
SERVER_PID=$!
sleep 2

echo "▶ 启动 editor ..."
npm run dev:editor
