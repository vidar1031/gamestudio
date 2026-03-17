#!/bin/bash
set -euo pipefail

ROOT="/Users/zhanghongqin/work/game_studio"
SERVER_PORT="${PORT:-1999}"
EDITOR_PORT="${VITE_PORT:-8868}"
SERVER_PID=""
DETACHED=0
RUN_DIR="${ROOT}/.run"
SERVER_LOG="${RUN_DIR}/server.log"
EDITOR_LOG="${RUN_DIR}/editor.log"
SERVER_PID_FILE="${RUN_DIR}/server.pid"
EDITOR_PID_FILE="${RUN_DIR}/editor.pid"

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
    if curl -fsS "${url}" >/dev/null 2>&1; then
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
  curl -fsS "${url}" >/dev/null 2>&1
}

already_running() {
  local server_pid
  local editor_pid
  server_pid="$(listener_pid "${SERVER_PORT}" || true)"
  editor_pid="$(listener_pid "${EDITOR_PORT}" || true)"
  if [ -z "${server_pid}" ] || [ -z "${editor_pid}" ]; then
    return 1
  fi
  http_ready "http://127.0.0.1:${SERVER_PORT}/api/health" || return 1
  http_ready "http://localhost:${EDITOR_PORT}" || return 1
  echo "${server_pid}" > "${SERVER_PID_FILE}"
  echo "${editor_pid}" > "${EDITOR_PID_FILE}"
  echo "ℹ️  Game Studio 已在运行，跳过重复启动"
  echo "Server PID: ${server_pid}"
  echo "Editor PID: ${editor_pid}"
  return 0
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

  if already_running; then
    exit 0
  fi

echo "▶ 构建 packages ..."
npm run build:packages
echo ""

if [ "${DETACHED}" = "1" ]; then
  EXISTING_SERVER_PID="$(listener_pid "${SERVER_PORT}" || true)"
  EXISTING_EDITOR_PID="$(listener_pid "${EDITOR_PORT}" || true)"

  if [ -n "${EXISTING_SERVER_PID}" ] && [ -n "${EXISTING_EDITOR_PID}" ]; then
    echo "${EXISTING_SERVER_PID}" > "${SERVER_PID_FILE}"
    echo "${EXISTING_EDITOR_PID}" > "${EDITOR_PID_FILE}"
    echo "ℹ️  server/editor 已在运行，跳过重复启动"
  elif [ -n "${EXISTING_SERVER_PID}" ] || [ -n "${EXISTING_EDITOR_PID}" ]; then
    echo "❌ 检测到端口处于半启动状态，请先运行 ./stop_project.sh 清理后再启动" >&2
    exit 1
  else
    echo "▶ 后台启动 server ..."
    SERVER_PID="$(spawn_detached "npm run dev:server" "${SERVER_LOG}")"
    sleep 2

    echo "▶ 后台启动 editor ..."
    EDITOR_PID="$(spawn_detached "npm run dev:editor" "${EDITOR_LOG}")"
  fi

  wait_for_http "http://127.0.0.1:${SERVER_PORT}/api/health" "server" 30
  wait_for_http "http://localhost:${EDITOR_PORT}" "editor" 30

  listener_pid "${SERVER_PORT}" > "${SERVER_PID_FILE}"
  listener_pid "${EDITOR_PORT}" > "${EDITOR_PID_FILE}"

  echo ""
  echo "✅ Detached launcher finished"
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
