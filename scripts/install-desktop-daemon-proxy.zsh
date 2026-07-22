#!/bin/zsh
set -euo pipefail

readonly ROOT="${0:A:h:h}"
readonly DOMAIN="gui/$(id -u)"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly PROXY_LABEL="com.lark-codex-desktop-proxy"
readonly ENV_LABEL="com.lark-codex-desktop-proxy-env"
readonly KEEPER_LABEL="com.lark-codex-daemon-keeper"
readonly PROXY_SOURCE="${ROOT}/deploy/${PROXY_LABEL}.plist"
readonly ENV_SOURCE="${ROOT}/deploy/${ENV_LABEL}.plist"
readonly KEEPER_SOURCE="${ROOT}/deploy/${KEEPER_LABEL}.plist"
readonly PROXY_TARGET="${HOME}/Library/LaunchAgents/${PROXY_LABEL}.plist"
readonly ENV_TARGET="${HOME}/Library/LaunchAgents/${ENV_LABEL}.plist"
readonly KEEPER_TARGET="${HOME}/Library/LaunchAgents/${KEEPER_LABEL}.plist"
readonly ENTRYPOINT="${ROOT}/dist/src/codex/daemon-loopback-proxy.js"
readonly INSTALLED_ENTRYPOINT="${CONFIG_DIR}/daemon-loopback-proxy.js"
readonly ENV_HELPER_SOURCE="${ROOT}/scripts/set-desktop-daemon-proxy-env.zsh"
readonly INSTALLED_ENV_HELPER="${CONFIG_DIR}/set-desktop-daemon-proxy-env.zsh"
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

readonly CODEX_BIN="${HOME}/.local/bin/codex"
if [[ ! -x "${CODEX_BIN}" ]]; then
  echo "未找到官方 standalone Codex CLI：${CODEX_BIN}" >&2
  exit 1
fi

umask 077
/bin/mkdir -p "${CONFIG_DIR}" "${HOME}/Library/LaunchAgents"
/bin/chmod 700 "${CONFIG_DIR}"
/usr/bin/install -m 600 "${ENTRYPOINT}" "${INSTALLED_ENTRYPOINT}"
/usr/bin/install -m 700 "${ENV_HELPER_SOURCE}" "${INSTALLED_ENV_HELPER}"
/usr/bin/openssl rand -hex 32 > "${TOKEN_FILE}"
/bin/chmod 600 "${TOKEN_FILE}"
readonly PATH_TOKEN="$(<"${TOKEN_FILE}")"
if [[ ! "${PATH_TOKEN}" =~ '^[a-f0-9]{64}$' ]]; then
  echo "Desktop daemon proxy token 格式无效。" >&2
  exit 1
fi
readonly PROXY_ARGUMENTS_JSON="$("${NODE_BIN}" -e '
  process.stdout.write(JSON.stringify(process.argv.slice(1)));
' "${NODE_BIN}" "${INSTALLED_ENTRYPOINT}" --port 48123 --token-file "${TOKEN_FILE}")"
readonly ENV_ARGUMENTS_JSON="$("${NODE_BIN}" -e '
  process.stdout.write(JSON.stringify(process.argv.slice(1)));
' /bin/zsh "${INSTALLED_ENV_HELPER}")"
readonly KEEPER_ARGUMENTS_JSON="$("${NODE_BIN}" -e '
  process.stdout.write(JSON.stringify(process.argv.slice(1)));
' "${CODEX_BIN}" app-server daemon start)"

/usr/bin/install -m 600 "${PROXY_SOURCE}" "${PROXY_TARGET}"
/usr/bin/plutil -replace ProgramArguments -json "${PROXY_ARGUMENTS_JSON}" "${PROXY_TARGET}"
/usr/bin/plutil -replace StandardOutPath -string "${CONFIG_DIR}/desktop-proxy.stdout.log" "${PROXY_TARGET}"
/usr/bin/plutil -replace StandardErrorPath -string "${CONFIG_DIR}/desktop-proxy.stderr.log" "${PROXY_TARGET}"
/usr/bin/plutil -lint "${PROXY_TARGET}"

/usr/bin/install -m 600 "${ENV_SOURCE}" "${ENV_TARGET}"
/usr/bin/plutil -replace ProgramArguments -json "${ENV_ARGUMENTS_JSON}" "${ENV_TARGET}"
/usr/bin/plutil -lint "${ENV_TARGET}"

/usr/bin/install -m 600 "${KEEPER_SOURCE}" "${KEEPER_TARGET}"
/usr/bin/plutil -replace ProgramArguments -json "${KEEPER_ARGUMENTS_JSON}" "${KEEPER_TARGET}"
/usr/bin/plutil -replace StandardOutPath -string "${CONFIG_DIR}/codex-daemon-keeper.stdout.log" "${KEEPER_TARGET}"
/usr/bin/plutil -replace StandardErrorPath -string "${CONFIG_DIR}/codex-daemon-keeper.stderr.log" "${KEEPER_TARGET}"
/usr/bin/plutil -lint "${KEEPER_TARGET}"

"${CODEX_BIN}" app-server daemon start

/bin/launchctl bootout "${DOMAIN}/${KEEPER_LABEL}" 2>/dev/null || true
/bin/launchctl bootstrap "${DOMAIN}" "${KEEPER_TARGET}"
/bin/launchctl enable "${DOMAIN}/${KEEPER_LABEL}"
/bin/launchctl kickstart -k "${DOMAIN}/${KEEPER_LABEL}"

/bin/launchctl bootout "${DOMAIN}/${PROXY_LABEL}" 2>/dev/null || true
/bin/launchctl bootstrap "${DOMAIN}" "${PROXY_TARGET}"
/bin/launchctl enable "${DOMAIN}/${PROXY_LABEL}"
/bin/launchctl kickstart -k "${DOMAIN}/${PROXY_LABEL}"

/bin/launchctl bootout "${DOMAIN}/${ENV_LABEL}" 2>/dev/null || true
/bin/launchctl bootstrap "${DOMAIN}" "${ENV_TARGET}"
/bin/launchctl enable "${DOMAIN}/${ENV_LABEL}"
/bin/launchctl kickstart -k "${DOMAIN}/${ENV_LABEL}"

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
