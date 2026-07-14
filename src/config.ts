import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface GatewayConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  allowedSenderId: string;
  codexBin: string;
  statePath: string;
  hostId: string;
  project: {
    projectId: string;
    displayName: string;
    workspacePath: string;
  };
  macbookWorker?: {
    workspacePath: string;
    sshUser: string;
    sshHost: string;
    sshPort: number;
    codexBin: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const workspacePath = realpathSync(required(env, "XIAOWANG_WORKSPACE_PATH"));
  const macbookWorkspacePath = optional(env, "XIAOWANG_MACBOOK_WORKSPACE_PATH");
  const config: GatewayConfig = {
    feishuAppId: required(env, "FEISHU_APP_ID"),
    feishuAppSecret: required(env, "FEISHU_APP_SECRET"),
    allowedSenderId: required(env, "FEISHU_ALLOWED_OPEN_ID"),
    codexBin: env.CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex",
    statePath: resolve(env.XIAOWANG_STATE_PATH ?? ".data/gateway.db"),
    hostId: env.XIAOWANG_HOST_ID ?? "unknown-host",
    project: {
      projectId: env.XIAOWANG_PROJECT_ID ?? "lark-codex-project",
      displayName: env.XIAOWANG_PROJECT_NAME ?? "Codex Project",
      workspacePath,
    },
  };
  if (macbookWorkspacePath) {
    config.macbookWorker = {
      workspacePath: macbookWorkspacePath,
      sshUser: required(env, "XIAOWANG_MACBOOK_SSH_USER"),
      sshHost: optional(env, "XIAOWANG_MACBOOK_SSH_HOST") ?? "127.0.0.1",
      sshPort: port(env.XIAOWANG_MACBOOK_SSH_PORT ?? "19022"),
      codexBin: optional(env, "XIAOWANG_MACBOOK_CODEX_BIN")
        ?? "/Applications/ChatGPT.app/Contents/Resources/codex",
    };
  }
  return config;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid SSH port: ${value}`);
  }
  return parsed;
}
