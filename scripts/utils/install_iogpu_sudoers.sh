#!/bin/bash
# 一次性安装 iogpu.wired_limit_mb 的 sudo 免密规则（仅限这一条 sysctl 命令，最小授权面）。
# 安装后，control 启动逻辑在需要时可自动提限，无需再手工输入密码。
# 用法：sudo bash scripts/utils/install_iogpu_sudoers.sh
set -euo pipefail

USER_NAME="${SUDO_USER:-$(whoami)}"
SUDOERS_FILE="/etc/sudoers.d/gamestudio-iogpu"
RULE="${USER_NAME} ALL=(root) NOPASSWD: /usr/sbin/sysctl iogpu.wired_limit_mb=*"

echo "将安装 sudoers 免密规则到 ${SUDOERS_FILE}："
echo "  ${RULE}"
echo "${RULE}" > "${SUDOERS_FILE}"
chmod 440 "${SUDOERS_FILE}"

# 校验语法（visudo 检查单个文件）
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "${SUDOERS_FILE}"
fi

echo "✅ 已安装。当前生效值："
sudo -n -u root /usr/sbin/sysctl iogpu.wired_limit_mb=26624 2>/dev/null || sudo -n /usr/sbin/sysctl iogpu.wired_limit_mb=26624
/usr/sbin/sysctl iogpu.wired_limit_mb
echo "提示：sysctl 已提限；若 OMLX 正在运行，control 下次启动 gateway 时会自动重启 omlx-server 使其生效。"
