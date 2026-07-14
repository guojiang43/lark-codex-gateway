import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("LaunchAgent packaging", () => {
  it("keeps credentials and machine-specific paths out of the plist template", () => {
    const plist = readFileSync(
      new URL("../deploy/com.lark-codex-gateway.plist", import.meta.url),
      "utf8",
    );

    expect(plist).toContain("<string>com.lark-codex-gateway</string>");
    expect(plist).toContain("__GATEWAY_RUNNER__");
    expect(plist).toContain("__GATEWAY_ROOT__");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("gateway.stderr.log");
    expect(plist).not.toContain("FEISHU_APP_SECRET");
    expect(plist).not.toContain("appSecret");
    expect(plist).not.toContain("/Users/");
  });

  it("installs the plist for the current checkout and records an explicit workspace", () => {
    const install = readFileSync(
      new URL("../scripts/install-launch-agent.zsh", import.meta.url),
      "utf8",
    );
    const uninstall = readFileSync(
      new URL("../scripts/uninstall-launch-agent.zsh", import.meta.url),
      "utf8",
    );

    expect(install).toContain("launchctl bootstrap");
    expect(install).toContain("launchctl kickstart -k");
    expect(install).toContain("WORKSPACE_INPUT");
    expect(install).toContain("workspace-path");
    expect(install).toContain("macbook-workspace-path");
    expect(install).toContain("allowed-open-id");
    expect(install).toContain("project-name");
    expect(install).toContain("macbook-ssh-user");
    expect(install).toContain("project-id");
    expect(install).toContain("plutil -remove ProgramArguments");
    expect(install).toContain("plutil -insert ProgramArguments -json");
    expect(install).toContain("plutil -replace WorkingDirectory");
    expect(install).not.toContain("/Users/");
    expect(install).not.toContain("launchctl load");
    expect(uninstall).toContain("launchctl bootout");
    expect(uninstall).not.toContain("launchctl unload");
  });

  it("runs from the current checkout and discovers the local Node and Codex binaries", () => {
    const runner = readFileSync(
      new URL("../scripts/run-gateway.zsh", import.meta.url),
      "utf8",
    );

    expect(runner).toContain("workspace-path");
    expect(runner).toContain("macbook-workspace-path");
    expect(runner).toContain("XIAOWANG_MACBOOK_WORKSPACE_PATH");
    expect(runner).toContain("project-id");
    expect(runner).toContain("app-id");
    expect(runner).toContain("allowed-open-id");
    expect(runner).toContain("project-name");
    expect(runner).toContain("macbook-ssh-user");
    expect(runner).toContain("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(runner).toContain("/Applications/Codex.app/Contents/Resources/codex");
    expect(runner).toContain("/usr/local/bin/node");
    expect(runner).toContain("/opt/homebrew/bin/node");
    expect(runner).not.toMatch(/cli_[a-z0-9]{12,}/i);
    expect(runner).not.toMatch(/ou_[a-z0-9]{12,}/i);
    expect(runner).not.toContain("/Users/");
    expect(runner).not.toContain('XIAOWANG_HOST_ID="m4-macmini"');
  });
});
