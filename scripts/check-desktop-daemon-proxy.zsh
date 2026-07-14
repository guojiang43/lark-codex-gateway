#!/bin/zsh
set -euo pipefail

readonly TOKEN_FILE="${HOME}/.config/lark-codex-worker/desktop-proxy-token"
if [[ ! -f "${TOKEN_FILE}" || "$(stat -f '%Lp' "${TOKEN_FILE}")" != "600" ]]; then
  echo "Desktop proxy token 文件缺失或权限不是 0600。" >&2
  exit 1
fi
readonly PATH_TOKEN="$(<"${TOKEN_FILE}")"
readonly EXPECTED_URL="ws://127.0.0.1:48123/${PATH_TOKEN}"
readonly ACTUAL_URL="$(/bin/launchctl getenv CODEX_APP_SERVER_WS_URL)"
if [[ "${ACTUAL_URL}" != "${EXPECTED_URL}" ]]; then
  echo "Desktop WS 地址未生效。" >&2
  exit 1
fi
if ! /usr/sbin/lsof -nP -iTCP:48123 -sTCP:LISTEN 2>/dev/null | /usr/bin/grep -q '127.0.0.1:48123'; then
  echo "Desktop daemon proxy 未监听 loopback 端口。" >&2
  exit 1
fi

readonly DESKTOP_PID="$(/usr/bin/pgrep -f '/Applications/(ChatGPT|Codex)\.app/Contents/MacOS/(ChatGPT|Codex)$' | /usr/bin/tail -n 1)"
if [[ -z "${DESKTOP_PID}" ]]; then
  echo "Codex Desktop 当前未运行。" >&2
  exit 1
fi
if /usr/bin/pgrep -P "${DESKTOP_PID}" -f '/Contents/Resources/codex .*app-server' >/dev/null; then
  echo "Codex Desktop 仍在运行独立 stdio app-server。" >&2
  exit 1
fi

readonly LOG_FILE="$(/usr/bin/find "${HOME}/Library/Logs/com.openai.codex" -type f -name "*-${DESKTOP_PID}-t0-i1-*.log" -print0 2>/dev/null | /usr/bin/xargs -0 /bin/ls -t 2>/dev/null | /usr/bin/head -n 1)"
readonly LAST_LOCAL_TRANSPORT="$(/usr/bin/grep 'Transport start success.*hostId=local' "${LOG_FILE}" 2>/dev/null | /usr/bin/tail -n 1)"
if [[ "${LAST_LOCAL_TRANSPORT}" != *'transport=websocket'* ]]; then
  echo "Codex Desktop 未使用 WebSocket 控制面。" >&2
  exit 1
fi

echo "desktop_realtime=healthy transport=websocket endpoint=protected_loopback"
