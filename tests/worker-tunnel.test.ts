import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("MacBook worker SSH tunnel packaging", () => {
  it("binds both worker SSH and the M4 reverse port to loopback only", () => {
    const sshdTemplate = readFileSync(
      new URL("../deploy/worker/sshd_config.template", import.meta.url),
      "utf8",
    );
    const tunnelPlist = readFileSync(
      new URL("../deploy/com.lark-codex-worker-tunnel.plist", import.meta.url),
      "utf8",
    );

    expect(sshdTemplate).toContain("ListenAddress 127.0.0.1");
    expect(sshdTemplate).toContain("PasswordAuthentication no");
    expect(sshdTemplate).toContain("KbdInteractiveAuthentication no");
    expect(sshdTemplate).toContain("AuthenticationMethods publickey");
    expect(tunnelPlist).toContain("127.0.0.1:19022:127.0.0.1:19022");
    expect(tunnelPlist).toContain("ExitOnForwardFailure=yes");
    expect(tunnelPlist).toContain("ServerAliveInterval=15");
    expect(tunnelPlist).toContain("ServerAliveCountMax=3");
  });

  it("installs separate keepalive agents without embedding private keys or app secrets", () => {
    const installer = readFileSync(
      new URL("../scripts/install-macbook-worker-tunnel.zsh", import.meta.url),
      "utf8",
    );
    const sshdPlist = readFileSync(
      new URL("../deploy/com.lark-codex-worker-sshd.plist", import.meta.url),
      "utf8",
    );
    const tunnelPlist = readFileSync(
      new URL("../deploy/com.lark-codex-worker-tunnel.plist", import.meta.url),
      "utf8",
    );

    expect(installer).toContain("ssh-keygen");
    expect(installer).toContain("authorized_keys");
    expect(installer).toContain("plutil -replace");
    expect(sshdPlist).toContain("<key>KeepAlive</key>");
    expect(tunnelPlist).toContain("<key>KeepAlive</key>");
    for (const content of [installer, sshdPlist, tunnelPlist]) {
      expect(content).not.toContain("FEISHU_APP_SECRET");
      expect(content).not.toContain("PRIVATE KEY");
    }
  });
});
