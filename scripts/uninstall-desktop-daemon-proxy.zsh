#!/bin/zsh
set -euo pipefail

readonly DOMAIN="gui/$(id -u)"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly PROXY_LABEL="com.lark-codex-desktop-proxy"
readonly ENV_LABEL="com.lark-codex-desktop-proxy-env"
readonly KEEPER_LABEL="com.lark-codex-daemon-keeper"
readonly LEGACY_ENV_LABEL="com.john.codex-desktop-daemon-env"

/bin/launchctl bootout "${DOMAIN}/${PROXY_LABEL}" 2>/dev/null || true
/bin/launchctl bootout "${DOMAIN}/${ENV_LABEL}" 2>/dev/null || true
/bin/launchctl bootout "${DOMAIN}/${KEEPER_LABEL}" 2>/dev/null || true
/bin/launchctl bootout "${DOMAIN}/${LEGACY_ENV_LABEL}" 2>/dev/null || true
/bin/launchctl unsetenv CODEX_APP_SERVER_WS_URL || true
/bin/launchctl unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON || true
/bin/rm -f \
  "${HOME}/Library/LaunchAgents/${PROXY_LABEL}.plist" \
  "${HOME}/Library/LaunchAgents/${ENV_LABEL}.plist" \
  "${HOME}/Library/LaunchAgents/${KEEPER_LABEL}.plist" \
  "${HOME}/Library/LaunchAgents/${LEGACY_ENV_LABEL}.plist" \
  "${CONFIG_DIR}/daemon-loopback-proxy.js" \
  "${CONFIG_DIR}/set-desktop-daemon-proxy-env.zsh" \
  "${CONFIG_DIR}/desktop-proxy-token"

echo "Desktop daemon proxy 已卸载。完整退出并重新打开 Codex Desktop 后生效。"
