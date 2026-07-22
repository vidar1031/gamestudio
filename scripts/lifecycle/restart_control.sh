#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:/bin:/usr/bin:${PATH}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${ROOT}/.run"

CONTROL_SERVER_PORT="2099"
CONTROL_CONSOLE_PORT="8870"

CONTROL_SERVER_LOG="${RUN_DIR}/control-server.log"
CONTROL_CONSOLE_LOG="${RUN_DIR}/control-console.log"
CONTROL_SERVER_PID_FILE="${RUN_DIR}/control-server.pid"
CONTROL_CONSOLE_PID_FILE="${RUN_DIR}/control-console.pid"

if [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "❌ 未找到 node，可执行 control-server 启动失败" >&2
  exit 1
fi

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
spawn_detached "env CONTROL_SERVER_PORT='${CONTROL_SERVER_PORT}' '${NODE_BIN}' apps/control-server/src/index.js" "${CONTROL_SERVER_LOG}" >/dev/null

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

# 自动打开或刷新浏览器（macOS）
open_or_refresh_browser() {
  local url="http://127.0.0.1:${CONTROL_CONSOLE_PORT}"
  local chrome_script="tell application \"Google Chrome\"
    set u to \"${url}\"
    set found to false
    repeat with w in windows
      set i to 1
      repeat with t in tabs of w
        if URL of t starts with u then
          set URL of t to u
          set active tab index of w to i
          set index of w to 1
          set found to true
          exit repeat
        end if
        set i to i + 1
      end repeat
      if found then exit repeat
    end repeat
    if not found then
      if (count of windows) = 0 then
        make new window
      end if
      tell front window to make new tab with properties {URL:u}
    end if
  end tell"

  local safari_script="tell application \"Safari\"
    set u to \"${url}\"
    set found to false
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with u then
          set URL of t to u
          set current tab of w to t
          set index of w to 1
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if not found then
      tell front document to make new tab with properties {URL:u}
    end if
  end tell"

  if command -v osascript >/dev/null 2>&1; then
    # 先尝试 Chrome
    if osascript -e "tell application \"Google Chrome\" to return name" >/dev/null 2>&1; then
      echo "🌐 正在刷新 Chrome..."
      osascript -e "${chrome_script}" 2>/dev/null && return 0
    fi
    # 再尝试 Safari
    if osascript -e "tell application \"Safari\" to return name" >/dev/null 2>&1; then
      echo "🌐 正在刷新 Safari..."
      osascript -e "${safari_script}" 2>/dev/null && return 0
    fi
  fi

  # Fallback: 普通 open
  if command -v open >/dev/null 2>&1; then
    echo "🌐 正在打开控制台..."
    open "${url}"
  fi
}

open_or_refresh_browser