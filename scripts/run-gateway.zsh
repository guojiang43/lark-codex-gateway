#!/bin/zsh
set -euo pipefail

readonly SCRIPT_DIR="${0:A:h}"
readonly ROOT="${SCRIPT_DIR:h}"
readonly KEYCHAIN_SERVICE="com.lark-codex-gateway.feishu"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-gateway"
readonly SECRET_FILE="${CONFIG_DIR}/feishu-app-secret"
readonly APP_ID_FILE="${CONFIG_DIR}/app-id"
readonly WORKSPACE_FILE="${CONFIG_DIR}/workspace-path"
readonly ALLOWED_OPEN_ID_FILE="${CONFIG_DIR}/allowed-open-id"
readonly PROJECT_ID_FILE="${CONFIG_DIR}/project-id"
readonly PROJECT_NAME_FILE="${CONFIG_DIR}/project-name"
readonly MACBOOK_WORKSPACE_FILE="${CONFIG_DIR}/macbook-workspace-path"
readonly MACBOOK_SSH_USER_FILE="${CONFIG_DIR}/macbook-ssh-user"
readonly CODEX_SANDBOX_FILE="${CONFIG_DIR}/codex-sandbox"
readonly CODEX_APPROVAL_POLICY_FILE="${CONFIG_DIR}/codex-approval-policy"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

read_config() {
  local path="$1"
  local name="$2"
  if [[ ! -f "${path}" || "$(stat -f '%Lp' "${path}")" != "600" ]]; then
    echo "缺少 ${name} 配置，或文件权限不是 0600。请重新运行安装脚本。" >&2
    exit 1
  fi
  REPLY="$(<"${path}")"
  if [[ -z "${REPLY}" ]]; then
    echo "${name} 配置不能为空。" >&2
    exit 1
  fi
}

read_config "${APP_ID_FILE}" "app-id"
readonly APP_ID="${REPLY}"
read_config "${WORKSPACE_FILE}" "workspace-path"
readonly WORKSPACE_PATH="${REPLY}"
read_config "${ALLOWED_OPEN_ID_FILE}" "allowed-open-id"
readonly ALLOWED_OPEN_ID="${REPLY}"
read_config "${PROJECT_ID_FILE}" "project-id"
readonly PROJECT_ID="${REPLY}"
read_config "${PROJECT_NAME_FILE}" "project-name"
readonly PROJECT_NAME="${REPLY}"

CODEX_SANDBOX="workspace-write"
if [[ -f "${CODEX_SANDBOX_FILE}" ]]; then
  read_config "${CODEX_SANDBOX_FILE}" "codex-sandbox"
  CODEX_SANDBOX="${REPLY}"
fi
if [[ "${CODEX_SANDBOX}" != "workspace-write" && "${CODEX_SANDBOX}" != "danger-full-access" ]]; then
  echo "codex-sandbox 只能是 workspace-write 或 danger-full-access。" >&2
  exit 1
fi

CODEX_APPROVAL_POLICY="on-request"
if [[ -f "${CODEX_APPROVAL_POLICY_FILE}" ]]; then
  read_config "${CODEX_APPROVAL_POLICY_FILE}" "codex-approval-policy"
  CODEX_APPROVAL_POLICY="${REPLY}"
fi
if [[ "${CODEX_APPROVAL_POLICY}" != "on-request" && "${CODEX_APPROVAL_POLICY}" != "never" ]]; then
  echo "codex-approval-policy 只能是 on-request 或 never。" >&2
  exit 1
fi

if [[ ! -d "${WORKSPACE_PATH}" ]]; then
  echo "配置的工作区不存在：${WORKSPACE_PATH}" >&2
  exit 1
fi

NODE_BIN=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [[ -x "${candidate}" ]]; then
    NODE_BIN="${candidate}"
    break
  fi
done
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "未找到可执行的 Node.js。" >&2
  exit 1
fi

CODEX_BINARY=""
for candidate in \
  /Applications/ChatGPT.app/Contents/Resources/codex \
  /Applications/Codex.app/Contents/Resources/codex; do
  if [[ -x "${candidate}" ]]; then
    CODEX_BINARY="${candidate}"
    break
  fi
done
if [[ -z "${CODEX_BINARY}" ]]; then
  CODEX_BINARY="$(command -v codex 2>/dev/null || true)"
fi
if [[ -z "${CODEX_BINARY}" || ! -x "${CODEX_BINARY}" ]]; then
  echo "未找到可执行的 Codex CLI。" >&2
  exit 1
fi

export FEISHU_APP_ID="${APP_ID}"
if FEISHU_SECRET="$(security find-generic-password -a "${APP_ID}" -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null)"; then
  export FEISHU_APP_SECRET="${FEISHU_SECRET}"
elif [[ -f "${SECRET_FILE}" && "$(stat -f '%Lp' "${SECRET_FILE}")" == "600" ]]; then
  export FEISHU_APP_SECRET="$(<"${SECRET_FILE}")"
else
  echo "未找到可用的飞书 App Secret，或 secret 文件权限不是 0600。" >&2
  exit 1
fi
unset FEISHU_SECRET

export FEISHU_ALLOWED_OPEN_ID="${ALLOWED_OPEN_ID}"
export XIAOWANG_WORKSPACE_PATH="${WORKSPACE_PATH:A}"
export XIAOWANG_PROJECT_ID="${PROJECT_ID}"
export XIAOWANG_PROJECT_NAME="${PROJECT_NAME}"
export XIAOWANG_CODEX_SANDBOX="${CODEX_SANDBOX}"
export XIAOWANG_CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY}"
if [[ -f "${MACBOOK_WORKSPACE_FILE}" ]]; then
  read_config "${MACBOOK_WORKSPACE_FILE}" "macbook-workspace-path"
  export XIAOWANG_MACBOOK_WORKSPACE_PATH="${REPLY}"
  read_config "${MACBOOK_SSH_USER_FILE}" "macbook-ssh-user"
  export XIAOWANG_MACBOOK_SSH_USER="${REPLY}"
  export XIAOWANG_MACBOOK_SSH_HOST="127.0.0.1"
  export XIAOWANG_MACBOOK_SSH_PORT="19022"
  export XIAOWANG_MACBOOK_CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
fi
export XIAOWANG_HOST_ID="$(/usr/sbin/scutil --get ComputerName 2>/dev/null || /bin/hostname -s)"
export XIAOWANG_STATE_PATH="${ROOT}/.data/gateway.db"
export CODEX_BIN="${CODEX_BINARY}"

cd "${ROOT}"
exec "${NODE_BIN}" dist/src/index.js
