#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 仅支持 macOS launchd" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.gamestudio.openclaw-watchdog"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
WATCHDOG_SCRIPT="${ROOT}/scripts/lifecycle/openclaw_watchdog.sh"

mkdir -p "${LAUNCH_AGENTS_DIR}"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WATCHDOG_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/tmp/gamestudio_openclaw_watchdog.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/gamestudio_openclaw_watchdog.err</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
launchctl enable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true

echo "✅ OpenClaw watchdog 已启用: ${LABEL}"
echo "检查日志: /tmp/gamestudio_openclaw_watchdog.log"
