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

# 引入进程管理库
source "${ROOT}/scripts/lifecycle/lib/process_manager.sh"

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

mkdir -p "${RUN_DIR}"

if [ ! -d "${ROOT}/node_modules" ]; then
  echo "❌ 未找到 ${ROOT}/node_modules，请先执行 npm install" >&2
  exit 1
fi

# 停止旧进程（优雅停止，确保端口释放）
stop_listener "control-server" "${CONTROL_SERVER_PORT}" || exit 1
stop_listener "control-console" "${CONTROL_CONSOLE_PORT}" || exit 1

rm -f "${CONTROL_SERVER_LOG}" "${CONTROL_CONSOLE_LOG}"
rm -f "${CONTROL_SERVER_PID_FILE}" "${CONTROL_CONSOLE_PID_FILE}"

echo "▶ 启动 control-server :${CONTROL_SERVER_PORT}"
spawn_detached "env CONTROL_SERVER_PORT='${CONTROL_SERVER_PORT}' '${NODE_BIN}' apps/control-server/src/index.js" "${CONTROL_SERVER_LOG}" "${ROOT}" >/dev/null

if ! wait_for_http_ready "http://127.0.0.1:${CONTROL_SERVER_PORT}/api/health" 30; then
  echo "❌ control-server 未在预期时间内就绪，请检查日志: ${CONTROL_SERVER_LOG}" >&2
  exit 1
fi

SERVER_PID="$(listener_pid "${CONTROL_SERVER_PORT}" || true)"
if [ -n "${SERVER_PID}" ]; then
  echo "${SERVER_PID}" > "${CONTROL_SERVER_PID_FILE}"
fi

echo "▶ 启动 control-console :${CONTROL_CONSOLE_PORT}"
spawn_detached "env CONTROL_SERVER_ORIGIN='http://127.0.0.1:${CONTROL_SERVER_PORT}' npm --workspace @game-studio/control-console run dev -- --host 0.0.0.0 --port ${CONTROL_CONSOLE_PORT} --strictPort" "${CONTROL_CONSOLE_LOG}" "${ROOT}" >/dev/null

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
