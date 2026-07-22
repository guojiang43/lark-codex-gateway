#!/bin/zsh
set -euo pipefail

readonly ROOT="${0:A:h:h}"
readonly DOMAIN="gui/$(id -u)"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly TOKEN_FILE="${CONFIG_DIR}/desktop-proxy-token"
readonly CONNECTION_LOG_CHECKER="${ROOT}/scripts/check-desktop-connection-log.zsh"
readonly KEEPER_LABEL="com.lark-codex-daemon-keeper"
readonly ENV_LABEL="com.lark-codex-desktop-proxy-env"
readonly CODEX_BIN="${HOME}/.local/bin/codex"

if [[ -x /opt/homebrew/bin/node ]]; then
  readonly NODE_BIN=/opt/homebrew/bin/node
elif [[ -x /usr/local/bin/node ]]; then
  readonly NODE_BIN=/usr/local/bin/node
else
  echo "未找到 Node.js 运行时。" >&2
  exit 1
fi

if ! /bin/launchctl print "${DOMAIN}/${KEEPER_LABEL}" >/dev/null 2>&1; then
  echo "Codex daemon keeper LaunchAgent 未加载。" >&2
  exit 1
fi
if ! /bin/launchctl print "${DOMAIN}/${ENV_LABEL}" >/dev/null 2>&1; then
  echo "Desktop proxy environment LaunchAgent 未加载。" >&2
  exit 1
fi
if [[ ! -x "${CODEX_BIN}" ]]; then
  echo "未找到官方 standalone Codex CLI：${CODEX_BIN}" >&2
  exit 1
fi
if ! "${CODEX_BIN}" app-server daemon version | "${NODE_BIN}" -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(input);
      const versions = [
        value.managedCodexVersion,
        value.cliVersion,
        value.appServerVersion,
      ];
      const hasCompatibleVersions = versions.every(
        (version) => typeof version === "string" && version.length > 0,
      ) && new Set(versions).size === 1;
      process.exit(
        value.status === "running"
        && typeof value.socketPath === "string"
        && value.socketPath.length > 0
        && hasCompatibleVersions
          ? 0
          : 1,
      );
    } catch {
      process.exit(1);
    }
  });
'; then
  echo "managed app-server daemon 未运行、缺少 socketPath，或 Codex 版本不兼容。" >&2
  exit 1
fi

if [[ ! -f "${TOKEN_FILE}" || "$(stat -f '%Lp' "${TOKEN_FILE}")" != "600" ]]; then
  echo "Desktop proxy token 文件缺失或权限不是 0600。" >&2
  exit 1
fi
readonly PATH_TOKEN="$(<"${TOKEN_FILE}")"
if [[ ! "${PATH_TOKEN}" =~ '^[a-f0-9]{64}$' ]]; then
  echo "Desktop proxy token 格式无效。" >&2
  exit 1
fi
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

readonly DESKTOP_PID="$(
  { /usr/bin/pgrep -f '/Applications/(ChatGPT|Codex)\.app/Contents/MacOS/(ChatGPT|Codex)$' || true; } \
    | /usr/bin/tail -n 1
)"
if [[ -z "${DESKTOP_PID}" ]]; then
  echo "Codex Desktop 当前未运行。" >&2
  exit 1
fi
if /usr/bin/pgrep -P "${DESKTOP_PID}" -f '/Contents/Resources/codex .*app-server' >/dev/null; then
  echo "Codex Desktop 仍在运行独立 stdio app-server。" >&2
  exit 1
fi

readonly LOG_FILE="$(
  {
    /usr/bin/find "${HOME}/Library/Logs/com.openai.codex" -type f -name "*-${DESKTOP_PID}-t0-i1-*.log" -exec /bin/ls -t {} + 2>/dev/null || true
  } | /usr/bin/head -n 1
)"
if [[ -z "${LOG_FILE}" ]]; then
  echo "未找到当前 Codex Desktop 日志。" >&2
  exit 1
fi
if [[ ! -x "${CONNECTION_LOG_CHECKER}" ]]; then
  echo "缺少 Desktop WebSocket 日志体检脚本。" >&2
  exit 1
fi
if ! "${CONNECTION_LOG_CHECKER}" "${LOG_FILE}"; then
  echo "Codex Desktop 最新本地 WebSocket 连接未初始化或已失败。" >&2
  exit 1
fi

echo "desktop_realtime=healthy daemon=running transport=websocket connection=initialized"
