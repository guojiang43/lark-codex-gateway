#!/bin/zsh
set -euo pipefail

readonly LABEL="com.lark-codex-gateway"
readonly TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
readonly DOMAIN="gui/$(id -u)"

/bin/launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
/bin/rm -f "${TARGET}"

echo "已移除 ${LABEL}；数据库和日志保留。"
