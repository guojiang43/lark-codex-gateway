#!/bin/zsh
set -euo pipefail

readonly LABEL="com.lark-codex-gateway"
readonly ROOT="${0:A:h:h}"
readonly SOURCE="${ROOT}/deploy/${LABEL}.plist"
readonly TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
readonly DOMAIN="gui/$(id -u)"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-gateway"
readonly APP_ID_FILE="${CONFIG_DIR}/app-id"
readonly WORKSPACE_FILE="${CONFIG_DIR}/workspace-path"
readonly ALLOWED_OPEN_ID_FILE="${CONFIG_DIR}/allowed-open-id"
readonly PROJECT_ID_FILE="${CONFIG_DIR}/project-id"
readonly PROJECT_NAME_FILE="${CONFIG_DIR}/project-name"
readonly MACBOOK_WORKSPACE_FILE="${CONFIG_DIR}/macbook-workspace-path"
readonly MACBOOK_SSH_USER_FILE="${CONFIG_DIR}/macbook-ssh-user"
readonly CODEX_SANDBOX_FILE="${CONFIG_DIR}/codex-sandbox"
readonly CODEX_APPROVAL_POLICY_FILE="${CONFIG_DIR}/codex-approval-policy"

readonly WORKSPACE_INPUT="${1:-}"
readonly PROJECT_ID_INPUT="${2:-}"
readonly PROJECT_NAME_INPUT="${3:-}"
readonly ALLOWED_OPEN_ID_INPUT="${4:-}"
readonly MACBOOK_WORKSPACE_INPUT="${5:-}"
readonly MACBOOK_SSH_USER_INPUT="${6:-}"
readonly CODEX_SANDBOX_INPUT="${7:-workspace-write}"
readonly CODEX_APPROVAL_POLICY_INPUT="${8:-on-request}"

if [[ -z "${WORKSPACE_INPUT}" || -z "${PROJECT_ID_INPUT}" || -z "${PROJECT_NAME_INPUT}" || -z "${ALLOWED_OPEN_ID_INPUT}" ]]; then
  echo "用法：$0 /绝对路径/工作区 project-id 'Project Name' ou_用户ID [/远端/工作区 远端SSH用户名 [workspace-write|danger-full-access] [on-request|never]]" >&2
  exit 1
fi
if [[ "${CODEX_SANDBOX_INPUT}" != "workspace-write" && "${CODEX_SANDBOX_INPUT}" != "danger-full-access" ]]; then
  echo "Codex sandbox 只能是 workspace-write 或 danger-full-access。" >&2
  exit 1
fi
if [[ "${CODEX_APPROVAL_POLICY_INPUT}" != "on-request" && "${CODEX_APPROVAL_POLICY_INPUT}" != "never" ]]; then
  echo "Codex approval policy 只能是 on-request 或 never。" >&2
  exit 1
fi
if [[ ! -d "${WORKSPACE_INPUT}" ]]; then
  echo "工作区不存在：${WORKSPACE_INPUT}" >&2
  exit 1
fi
if [[ ! "${PROJECT_ID_INPUT}" =~ '^[a-zA-Z0-9._-]+$' ]]; then
  echo "Project ID 格式无效：${PROJECT_ID_INPUT}" >&2
  exit 1
fi
if [[ ! "${ALLOWED_OPEN_ID_INPUT}" =~ '^ou_[A-Za-z0-9]+$' ]]; then
  echo "允许用户 open_id 格式无效。" >&2
  exit 1
fi
if [[ -n "${MACBOOK_WORKSPACE_INPUT}" || -n "${MACBOOK_SSH_USER_INPUT}" ]]; then
  if [[ "${MACBOOK_WORKSPACE_INPUT}" != /* || ! "${MACBOOK_SSH_USER_INPUT}" =~ '^[A-Za-z_][A-Za-z0-9._-]*$' ]]; then
    echo "远端工作区必须是绝对路径，且必须提供有效 SSH 用户名。" >&2
    exit 1
  fi
fi
if [[ ! -f "${APP_ID_FILE}" || "$(stat -f '%Lp' "${APP_ID_FILE}")" != "600" ]]; then
  echo "缺少权限为 0600 的 app-id。请先运行 scripts/setup-keychain-secret.zsh cli_应用ID。" >&2
  exit 1
fi

umask 077
/bin/mkdir -p "${CONFIG_DIR}"
/bin/chmod 700 "${CONFIG_DIR}"
write_config() {
  local path="$1"
  local value="$2"
  print -rn -- "${value}" > "${path}"
  /bin/chmod 600 "${path}"
}
write_config "${WORKSPACE_FILE}" "${WORKSPACE_INPUT:A}"
write_config "${PROJECT_ID_FILE}" "${PROJECT_ID_INPUT}"
write_config "${PROJECT_NAME_FILE}" "${PROJECT_NAME_INPUT}"
write_config "${ALLOWED_OPEN_ID_FILE}" "${ALLOWED_OPEN_ID_INPUT}"
write_config "${CODEX_SANDBOX_FILE}" "${CODEX_SANDBOX_INPUT}"
write_config "${CODEX_APPROVAL_POLICY_FILE}" "${CODEX_APPROVAL_POLICY_INPUT}"

if [[ -n "${MACBOOK_WORKSPACE_INPUT}" ]]; then
  write_config "${MACBOOK_WORKSPACE_FILE}" "${MACBOOK_WORKSPACE_INPUT}"
  write_config "${MACBOOK_SSH_USER_FILE}" "${MACBOOK_SSH_USER_INPUT}"
else
  /bin/rm -f "${MACBOOK_WORKSPACE_FILE}" "${MACBOOK_SSH_USER_FILE}"
fi

/bin/launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
if pgrep -f "node dist/src/index.js" >/dev/null; then
  echo "检测到前台网关进程。请先正常停止，再安装 LaunchAgent，避免双消费者。" >&2
  exit 1
fi

/usr/bin/plutil -lint "${SOURCE}"
/bin/mkdir -p "${HOME}/Library/LaunchAgents" "${ROOT}/.data"
/bin/chmod 700 "${ROOT}/.data"
/usr/bin/install -m 600 "${SOURCE}" "${TARGET}"
/usr/bin/plutil -remove ProgramArguments "${TARGET}"
/usr/bin/plutil -insert ProgramArguments -json "[\"/bin/zsh\",\"${ROOT}/scripts/run-gateway.zsh\"]" "${TARGET}"
/usr/bin/plutil -replace WorkingDirectory -string "${ROOT}" "${TARGET}"
/usr/bin/plutil -replace StandardOutPath -string "${ROOT}/.data/gateway.stdout.log" "${TARGET}"
/usr/bin/plutil -replace StandardErrorPath -string "${ROOT}/.data/gateway.stderr.log" "${TARGET}"
/usr/bin/plutil -lint "${TARGET}"

/bin/launchctl bootstrap "${DOMAIN}" "${TARGET}"
/bin/launchctl enable "${DOMAIN}/${LABEL}"
/bin/launchctl kickstart -k "${DOMAIN}/${LABEL}"
/bin/launchctl print "${DOMAIN}/${LABEL}"
