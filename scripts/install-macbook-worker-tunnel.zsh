#!/bin/zsh
set -euo pipefail

readonly ROOT="${0:A:h:h}"
readonly PUBLIC_KEY_SOURCE="${1:-}"
readonly GATEWAY_SSH_HOST="${2:-}"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-worker"
readonly SSHD_CONFIG="${CONFIG_DIR}/sshd_config"
readonly AUTHORIZED_KEYS="${CONFIG_DIR}/authorized_keys"
readonly SSHD_LABEL="com.lark-codex-worker-sshd"
readonly TUNNEL_LABEL="com.lark-codex-worker-tunnel"
readonly DOMAIN="gui/$(id -u)"

if [[ -z "${PUBLIC_KEY_SOURCE}" || ! -s "${PUBLIC_KEY_SOURCE}" || -z "${GATEWAY_SSH_HOST}" ]]; then
  echo "用法：$0 /path/to/gateway-public-key gateway-ssh-host" >&2
  exit 1
fi
if ! /usr/bin/grep -Eq '^ssh-(ed25519|rsa) ' "${PUBLIC_KEY_SOURCE}"; then
  echo "网关主机公钥格式无效。" >&2
  exit 1
fi

umask 077
/bin/mkdir -p "${CONFIG_DIR}" "${HOME}/Library/LaunchAgents"
/bin/chmod 700 "${CONFIG_DIR}"
/usr/bin/install -m 600 "${PUBLIC_KEY_SOURCE}" "${AUTHORIZED_KEYS}"
if [[ ! -s "${CONFIG_DIR}/ssh_host_ed25519_key" ]]; then
  /usr/bin/ssh-keygen -q -t ed25519 -N '' -f "${CONFIG_DIR}/ssh_host_ed25519_key"
fi
/bin/chmod 600 "${CONFIG_DIR}/ssh_host_ed25519_key" "${CONFIG_DIR}/ssh_host_ed25519_key.pub"

/usr/bin/sed \
  -e "s|__CONFIG_DIR__|${CONFIG_DIR}|g" \
  -e "s|__USER__|${USER}|g" \
  "${ROOT}/deploy/worker/sshd_config.template" > "${SSHD_CONFIG}"
/bin/chmod 600 "${SSHD_CONFIG}"
/usr/sbin/sshd -t -f "${SSHD_CONFIG}"

install_agent() {
  local label="$1"
  local source="${ROOT}/deploy/${label}.plist"
  local target="${HOME}/Library/LaunchAgents/${label}.plist"
  /usr/bin/plutil -lint "${source}"
  /usr/bin/install -m 600 "${source}" "${target}"
  /usr/bin/plutil -replace WorkingDirectory -string "${HOME}" "${target}"
  /usr/bin/plutil -replace StandardOutPath -string "${CONFIG_DIR}/${label}.stdout.log" "${target}"
  /usr/bin/plutil -replace StandardErrorPath -string "${CONFIG_DIR}/${label}.stderr.log" "${target}"
  if [[ "${label}" == "${SSHD_LABEL}" ]]; then
    /usr/bin/plutil -remove ProgramArguments "${target}"
    /usr/bin/plutil -insert ProgramArguments -json \
      "[\"/usr/sbin/sshd\",\"-D\",\"-e\",\"-f\",\"${SSHD_CONFIG}\"]" "${target}"
  else
    /usr/bin/plutil -remove ProgramArguments "${target}"
    /usr/bin/plutil -insert ProgramArguments -json \
      "[\"/usr/bin/ssh\",\"-N\",\"-T\",\"-o\",\"BatchMode=yes\",\"-o\",\"ExitOnForwardFailure=yes\",\"-o\",\"ServerAliveInterval=15\",\"-o\",\"ServerAliveCountMax=3\",\"-R\",\"127.0.0.1:19022:127.0.0.1:19022\",\"${GATEWAY_SSH_HOST}\"]" "${target}"
  fi
  /usr/bin/plutil -lint "${target}"
  /bin/launchctl bootout "${DOMAIN}/${label}" 2>/dev/null || true
  /bin/launchctl bootstrap "${DOMAIN}" "${target}"
  /bin/launchctl enable "${DOMAIN}/${label}"
  /bin/launchctl kickstart -k "${DOMAIN}/${label}"
}

install_agent "${SSHD_LABEL}"
install_agent "${TUNNEL_LABEL}"

/bin/launchctl print "${DOMAIN}/${SSHD_LABEL}"
/bin/launchctl print "${DOMAIN}/${TUNNEL_LABEL}"
