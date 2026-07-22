#!/bin/zsh
set -euo pipefail

readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly TOKEN_FILE="${CONFIG_DIR}/desktop-proxy-token"

if [[ ! -f "${TOKEN_FILE}" || "$(stat -f '%Lp' "${TOKEN_FILE}")" != "600" ]]; then
  echo "Desktop proxy token 文件缺失或权限不是 0600。" >&2
  exit 1
fi

readonly PATH_TOKEN="$(<"${TOKEN_FILE}")"
if [[ ! "${PATH_TOKEN}" =~ '^[a-f0-9]{64}$' ]]; then
  echo "Desktop proxy token 格式无效。" >&2
  exit 1
fi

/bin/launchctl setenv CODEX_APP_SERVER_WS_URL "ws://127.0.0.1:48123/${PATH_TOKEN}"
