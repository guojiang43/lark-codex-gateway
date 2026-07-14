import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

function baseEnv(workspacePath: string): NodeJS.ProcessEnv {
  return {
    FEISHU_APP_ID: "app",
    FEISHU_APP_SECRET: "secret",
    FEISHU_ALLOWED_OPEN_ID: "allowed-user",
    XIAOWANG_WORKSPACE_PATH: workspacePath,
  };
}

describe("loadConfig", () => {
  it("keeps the MacBook worker optional for safe single-host startup", () => {
    const workspace = mkdtempSync(join(tmpdir(), "xiaowang-m4-"));
    const config = loadConfig(baseEnv(workspace));

    expect(config.project.workspacePath).toBe(realpathSync(workspace));
    expect(config.macbookWorker).toBeUndefined();
  });

  it("loads the reverse-SSH MacBook worker without confusing it with Feishu ingress", () => {
    const m4Workspace = mkdtempSync(join(tmpdir(), "xiaowang-m4-"));
    const env = baseEnv(m4Workspace);
    Object.assign(env, {
      XIAOWANG_MACBOOK_WORKSPACE_PATH: "/Users/example/workspace",
      XIAOWANG_MACBOOK_SSH_USER: "example-user",
      XIAOWANG_MACBOOK_SSH_HOST: "127.0.0.1",
      XIAOWANG_MACBOOK_SSH_PORT: "19022",
      XIAOWANG_MACBOOK_CODEX_BIN: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });

    const config = loadConfig(env);

    expect(config.macbookWorker).toEqual({
      workspacePath: "/Users/example/workspace",
      sshUser: "example-user",
      sshHost: "127.0.0.1",
      sshPort: 19022,
      codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });
    expect(config.hostId).not.toBe("macbook");
  });

  it("uses deployment-neutral project defaults", () => {
    const workspace = mkdtempSync(join(tmpdir(), "lark-codex-"));
    const config = loadConfig(baseEnv(workspace));

    expect(config.project.projectId).toBe("lark-codex-project");
    expect(config.project.displayName).toBe("Codex Project");
  });

  it("requires an SSH user whenever a remote worker is configured", () => {
    const workspace = mkdtempSync(join(tmpdir(), "lark-codex-"));
    const env = baseEnv(workspace);
    env.XIAOWANG_MACBOOK_WORKSPACE_PATH = "/Users/example/workspace";

    expect(() => loadConfig(env)).toThrow(
      "missing required environment variable: XIAOWANG_MACBOOK_SSH_USER",
    );
  });
});
