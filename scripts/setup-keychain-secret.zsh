#!/bin/zsh
set -euo pipefail

readonly APP_ID="${1:-}"
readonly SERVICE="com.lark-codex-gateway.feishu"
readonly CONFIG_DIR="${HOME}/.config/lark-codex-gateway"
readonly APP_ID_FILE="${CONFIG_DIR}/app-id"
readonly SECRET_FILE="${CONFIG_DIR}/feishu-app-secret"

if [[ ! "${APP_ID}" =~ '^cli_[A-Za-z0-9]+$' ]]; then
  echo "用法：$0 cli_应用ID" >&2
  exit 1
fi

read -r -s "APP_SECRET?请输入飞书应用的 App Secret（输入不会回显）: "
echo
if [[ -z "${APP_SECRET}" ]]; then
  echo "App Secret 不能为空" >&2
  exit 1
fi

umask 077
/bin/mkdir -p "${CONFIG_DIR}"
/bin/chmod 700 "${CONFIG_DIR}"
print -rn -- "${APP_ID}" > "${APP_ID_FILE}"
/bin/chmod 600 "${APP_ID_FILE}"

if security add-generic-password \
  -U \
  -a "${APP_ID}" \
  -s "${SERVICE}" \
  -w "${APP_SECRET}" >/dev/null 2>&1; then
  STORAGE="登录钥匙串"
else
  print -rn -- "${APP_SECRET}" | /usr/bin/tee "${SECRET_FILE}" >/dev/null
  /bin/chmod 600 "${SECRET_FILE}"
  STORAGE="权限 0600 的受保护配置"
fi
unset APP_SECRET

if [[ "${STORAGE}" == "登录钥匙串" ]]; then
  security find-generic-password -a "${APP_ID}" -s "${SERVICE}" >/dev/null
else
  [[ "$(stat -f '%Lp' "${SECRET_FILE}")" == "600" ]]
fi
echo "网关凭据已写入${STORAGE}，值未输出。"
