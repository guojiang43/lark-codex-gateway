#!/bin/zsh
set -euo pipefail

readonly ROOT="${0:A:h:h}"
readonly DOMAIN="gui/$(id -u)"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly PROXY_LABEL="com.lark-codex-desktop-proxy"
readonly ENV_LABEL="com.lark-codex-desktop-proxy-env"
readonly PROXY_SOURCE="${ROOT}/deploy/${PROXY_LABEL}.plist"
readonly ENV_SOURCE="${ROOT}/deploy/${ENV_LABEL}.plist"
readonly PROXY_TARGET="${HOME}/Library/LaunchAgents/${PROXY_LABEL}.plist"
readonly ENV_TARGET="${HOME}/Library/LaunchAgents/${ENV_LABEL}.plist"
readonly ENTRYPOINT="${ROOT}/dist/src/codex/daemon-loopback-proxy.js"
readonly INSTALLED_ENTRYPOINT="${CONFIG_DIR}/daemon-loopback-proxy.js"
readonly TOKEN_FILE="${CONFIG_DIR}/desktop-proxy-token"

if [[ ! -f "${ENTRYPOINT}" ]]; then
  echo "缺少已构建的 Desktop daemon proxy：${ENTRYPOINT}。请先运行 npm run build。" >&2
  exit 1
fi
if [[ -x /opt/homebrew/bin/node ]]; then
  readonly NODE_BIN=/opt/homebrew/bin/node
elif [[ -x /usr/local/bin/node ]]; then
  readonly NODE_BIN=/usr/local/bin/node
else
  echo "未找到 Node.js 运行时。" >&2
  exit 1
fi

readonly CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
if [[ ! -x "${CODEX_BIN}" ]]; then
  echo "未找到 Codex Desktop CLI。" >&2
  exit 1
fi
if ! "${CODEX_BIN}" app-server daemon version | "${NODE_BIN}" -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    process.exit(value.status === "running" && typeof value.socketPath === "string" ? 0 : 1);
  });
'; then
  echo "managed app-server daemon 未就绪。" >&2
  exit 1
fi

umask 077
/bin/mkdir -p "${CONFIG_DIR}" "${HOME}/Library/LaunchAgents"
/bin/chmod 700 "${CONFIG_DIR}"
/usr/bin/install -m 600 "${ENTRYPOINT}" "${INSTALLED_ENTRYPOINT}"
if [[ ! -s "${TOKEN_FILE}" ]]; then
  /usr/bin/openssl rand -hex 32 > "${TOKEN_FILE}"
fi
/bin/chmod 600 "${TOKEN_FILE}"
readonly PATH_TOKEN="$(<"${TOKEN_FILE}")"
if [[ ! "${PATH_TOKEN}" =~ '^[a-f0-9]{64}$' ]]; then
  echo "Desktop daemon proxy token 格式无效。" >&2
  exit 1
fi
readonly DESKTOP_WS_URL="ws://127.0.0.1:48123/${PATH_TOKEN}"
readonly PROXY_ARGUMENTS_JSON="$("${NODE_BIN}" -e '
  process.stdout.write(JSON.stringify(process.argv.slice(1)));
' "${NODE_BIN}" "${INSTALLED_ENTRYPOINT}" --port 48123 --token-file "${TOKEN_FILE}")"
readonly ENV_ARGUMENTS_JSON="$("${NODE_BIN}" -e '
  process.stdout.write(JSON.stringify(process.argv.slice(1)));
' /bin/launchctl setenv CODEX_APP_SERVER_WS_URL "${DESKTOP_WS_URL}")"

/usr/bin/install -m 600 "${PROXY_SOURCE}" "${PROXY_TARGET}"
/usr/bin/plutil -replace ProgramArguments -json "${PROXY_ARGUMENTS_JSON}" "${PROXY_TARGET}"
/usr/bin/plutil -replace StandardOutPath -string "${CONFIG_DIR}/desktop-proxy.stdout.log" "${PROXY_TARGET}"
/usr/bin/plutil -replace StandardErrorPath -string "${CONFIG_DIR}/desktop-proxy.stderr.log" "${PROXY_TARGET}"
/usr/bin/plutil -lint "${PROXY_TARGET}"

/usr/bin/install -m 600 "${ENV_SOURCE}" "${ENV_TARGET}"
/usr/bin/plutil -replace ProgramArguments -json "${ENV_ARGUMENTS_JSON}" "${ENV_TARGET}"
/usr/bin/plutil -lint "${ENV_TARGET}"

/bin/launchctl bootout "${DOMAIN}/${PROXY_LABEL}" 2>/dev/null || true
/bin/launchctl bootstrap "${DOMAIN}" "${PROXY_TARGET}"
/bin/launchctl enable "${DOMAIN}/${PROXY_LABEL}"
/bin/launchctl kickstart -k "${DOMAIN}/${PROXY_LABEL}"

/bin/launchctl bootout "${DOMAIN}/${ENV_LABEL}" 2>/dev/null || true
/bin/launchctl bootstrap "${DOMAIN}" "${ENV_TARGET}"
/bin/launchctl setenv CODEX_APP_SERVER_WS_URL "${DESKTOP_WS_URL}"

for _ in {1..50}; do
  if /usr/sbin/lsof -nP -iTCP:48123 -sTCP:LISTEN 2>/dev/null | /usr/bin/grep -q '127.0.0.1:48123'; then
    echo "Desktop daemon proxy 已在受保护的 loopback 地址监听。"
    echo "需要完整退出并重新打开 Codex Desktop 后，新的显式连接地址才会生效。"
    exit 0
  fi
  /bin/sleep 0.1
done

echo "Desktop daemon proxy 未能监听 127.0.0.1:48123。" >&2
exit 1
