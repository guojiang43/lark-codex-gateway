#!/bin/zsh
set -euo pipefail

if [[ "$#" -ne 1 || ! -f "$1" ]]; then
  echo "Codex Desktop 日志文件缺失。" >&2
  exit 2
fi

readonly LOG_FILE="$1"
readonly LAST_LOCAL_CONNECTION="$(
  {
    /usr/bin/grep -E 'app_server_connection\.state_changed.*hostId=local.*transport=websocket' "${LOG_FILE}" 2>/dev/null || true
  } | /usr/bin/tail -n 1
)"

if [[ -z "${LAST_LOCAL_CONNECTION}" ]]; then
  echo "Codex Desktop 没有本地 WebSocket 连接状态。" >&2
  exit 1
fi
if [[ "${LAST_LOCAL_CONNECTION}" != *'initialized=true'* \
  || "${LAST_LOCAL_CONNECTION}" != *'hasConnection=true'* \
  || "${LAST_LOCAL_CONNECTION}" != *'next=connected'* ]]; then
  echo "Codex Desktop 最新本地 WebSocket 连接未完成初始化。" >&2
  exit 1
fi
