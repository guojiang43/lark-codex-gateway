#!/bin/zsh
set -euo pipefail

readonly DOMAIN="gui/$(id -u)"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly PROXY_LABEL="com.lark-codex-desktop-proxy"
readonly ENV_LABEL="com.lark-codex-desktop-proxy-env"

/bin/launchctl bootout "${DOMAIN}/${PROXY_LABEL}" 2>/dev/null || true
/bin/launchctl bootout "${DOMAIN}/${ENV_LABEL}" 2>/dev/null || true
/bin/launchctl unsetenv CODEX_APP_SERVER_WS_URL
/bin/rm -f \
  "${HOME}/Library/LaunchAgents/${PROXY_LABEL}.plist" \
  "${HOME}/Library/LaunchAgents/${ENV_LABEL}.plist" \
  "${CONFIG_DIR}/daemon-loopback-proxy.js" \
  "${CONFIG_DIR}/desktop-proxy-token"

echo "Desktop daemon proxy 已卸载。完整退出并重新打开 Codex Desktop 后生效。"
