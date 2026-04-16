#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 仅支持 macOS launchd" >&2
  exit 1
fi

LABEL="com.gamestudio.openclaw-watchdog"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST_PATH}"

echo "✅ OpenClaw watchdog 已移除: ${LABEL}"
