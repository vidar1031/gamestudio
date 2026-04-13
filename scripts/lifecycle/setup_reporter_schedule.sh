#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST_SRC="${ROOT}/.openclaw/com.gamestudio.reporter.plist"
CONFIG_FILE="${ROOT}/.openclaw/email_config.sh"
LABEL="com.gamestudio.reporter"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_DEST="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ 仅支持在 macOS 上配置 launchd 定时任务" >&2
  exit 1
fi

if [ ! -f "${PLIST_SRC}" ]; then
  echo "❌ 未找到定时任务模板: ${PLIST_SRC}" >&2
  exit 1
fi

if [ ! -f "${CONFIG_FILE}" ]; then
  echo "❌ 未找到邮件配置: ${CONFIG_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${CONFIG_FILE}"
if [ -z "${RECIPIENT:-}" ] || [ -z "${SENDER_EMAIL:-}" ]; then
  echo "❌ 邮件配置不完整，请先检查 ${CONFIG_FILE}" >&2
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}"
cp "${PLIST_SRC}" "${PLIST_DEST}"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST_DEST}"
launchctl enable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true

echo "✅ 定时任务已安装并启用: ${LABEL}"
echo "plist: ${PLIST_DEST}"
launchctl print "gui/$(id -u)/${LABEL}" | head -n 40
