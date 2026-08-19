#!/bin/bash
# ComfyUI 自愈：安装 custom_nodes 缺失的 Python 依赖，可选重启 ComfyUI 使节点生效
# 用法: comfyui_auto_fix.sh [--restart]
# 环境变量: COMFYUI_ROOT（默认 /Volumes/ovokit2t/ComfyUI）、COMFYUI_BASE_URL（默认 http://127.0.0.1:8188）
set -uo pipefail

COMFYUI_ROOT="${COMFYUI_ROOT:-/Volumes/ovokit2t/ComfyUI}"
COMFYUI_BASE_URL="${COMFYUI_BASE_URL:-http://127.0.0.1:8188}"
PIP="$COMFYUI_ROOT/venv/bin/pip"
PKGS=(opencv-python matplotlib onnxruntime segment-anything hydra-core timm)

echo "[auto-fix] comfyui root: $COMFYUI_ROOT"
if [ ! -x "$PIP" ]; then
  echo "[auto-fix][error] pip 不存在: $PIP"
  exit 1
fi

echo "[auto-fix] 安装 Python 依赖: ${PKGS[*]}"
"$PIP" install "${PKGS[@]}" || exit 1
echo "[auto-fix] deps_ok"

if [[ "${1:-}" == "--restart" ]]; then
  echo "[auto-fix] 重启 ComfyUI…"
  # 按监听端口精准定位进程（进程命令行只有 "main.py"，pkill -f ComfyUI/main.py 匹配不到）
  COMFY_PID=$(lsof -ti tcp@127.0.0.1:8188 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$COMFY_PID" ]; then
    kill $COMFY_PID 2>/dev/null || true
    sleep 3
    kill -9 $COMFY_PID 2>/dev/null || true
  fi
  sleep 2
  osascript -e "tell application \"Terminal\" to do script \"cd '$COMFYUI_ROOT' && sh ./start.sh\"" >/dev/null 2>&1 || {
    echo "[auto-fix][error] 无法通过 Terminal 启动 ComfyUI"
    exit 1
  }
  for i in $(seq 1 60); do
    if curl -sf --max-time 2 "$COMFYUI_BASE_URL/system_stats" >/dev/null 2>&1; then
      echo "[auto-fix] comfyui_restarted"
      exit 0
    fi
    sleep 2
  done
  echo "[auto-fix][error] ComfyUI 重启后健康检查超时"
  exit 1
fi

echo "[auto-fix] done"
