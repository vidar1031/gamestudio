#!/bin/bash
set -euo pipefail

LABEL="com.gamestudio.reporter"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 仅支持在 macOS 上管理 launchd 定时任务" >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST_DEST}"

echo "✅ 定时任务已移除: ${LABEL}"
