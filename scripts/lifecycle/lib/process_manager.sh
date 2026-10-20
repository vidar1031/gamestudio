#!/bin/bash
# 进程管理库：统一的生命周期管理函数
# 供 start/stop/restart 脚本引用

# 查找监听端口的进程 PID
listener_pid() {
  local port="$1"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

# 等待端口释放
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

# 等待 HTTP 服务就绪
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

# 优雅停止进程（先 SIGTERM，再 SIGKILL）
stop_process_gracefully() {
  local pid="$1"
  local name="${2:-process}"
  if [ -z "${pid}" ]; then
    return 0
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi
  echo "ℹ️ 停止 ${name}: pid ${pid}（SIGTERM）"
  kill "${pid}" 2>/dev/null || true
  # 等待最多 5 秒
  local waited=0
  while [ "${waited}" -lt 5 ]; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # 强制 SIGKILL
  if kill -0 "${pid}" 2>/dev/null; then
    echo "⚠️ ${name} 未响应 SIGTERM，强制 SIGKILL: pid ${pid}"
    kill -9 "${pid}" 2>/dev/null || true
    sleep 1
  fi
}

# 停止监听指定端口的进程
stop_listener() {
  local name="$1"
  local port="$2"
  local pid
  pid="$(listener_pid "${port}" || true)"
  if [ -n "${pid}" ]; then
    stop_process_gracefully "${pid}" "${name}"
  fi
  if ! wait_for_port_free "${port}" 20; then
    echo "❌ ${name} 端口 ${port} 未释放" >&2
    return 1
  fi
  return 0
}

# 清理指定模式的所有进程
cleanup_processes_by_pattern() {
  local pattern="$1"
  local name="${2:-processes}"
  local pids
  pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
  if [ -n "${pids}" ]; then
    echo "ℹ️ 清理 ${name}: $(echo "${pids}" | tr '\n' ' ')"
    echo "${pids}" | xargs kill 2>/dev/null || true
    sleep 2
    # 强制清理仍在运行的
    pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
    if [ -n "${pids}" ]; then
      echo "${pids}" | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
  fi
}

# 确保端口可用（被占用则清理）
ensure_port_free() {
  local port="$1"
  local name="${2:-service}"
  local max_attempts=5
  local attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    local pid
    pid="$(listener_pid "${port}" || true)"
    if [ -z "${pid}" ]; then
      return 0
    fi
    echo "⚠️ 端口 ${port} 被 pid ${pid} 占用，清理中（${attempt}/${max_attempts}）..."
    stop_process_gracefully "${pid}" "${name}"
    attempt=$((attempt + 1))
  done
  echo "❌ 端口 ${port} 无法释放" >&2
  return 1
}

# 后台启动进程（带进程组管理）
spawn_detached() {
  local cmd="$1"
  local log_file="$2"
  local work_dir="${3:-.}"
  mkdir -p "$(dirname "${log_file}")"
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -lc "cd '${work_dir}' && exec ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  else
    nohup bash -lc "cd '${work_dir}' && exec ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  fi
  echo $!
}

# 一键清理所有 TalkScene 相关进程
cleanup_all_talkscene_processes() {
  echo "=== 清理 TalkScene 所有进程 ==="
  stop_listener "control-server" 2099 || true
  stop_listener "control-console" 8870 || true
  stop_listener "talkscene-server" 1999 || true
  stop_listener "talkscene-editor" 8868 || true
  stop_listener "hermes-gateway" 8742 || true
  cleanup_processes_by_pattern 'hermes-gateway' 'hermes-gateway' || true
  cleanup_processes_by_pattern 'start-hermes-visible.sh' 'hermes-launcher' || true
  echo "=== 清理完成 ==="
}
