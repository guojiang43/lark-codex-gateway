import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("packages a persistent loopback-only Desktop daemon bridge", () => {
    const installer = readFileSync(
      new URL("../scripts/install-desktop-daemon-proxy.zsh", import.meta.url),
      "utf8",
    );
    const proxyPlist = readFileSync(
      new URL("../deploy/com.lark-codex-desktop-proxy.plist", import.meta.url),
      "utf8",
    );
    const envPlist = readFileSync(
      new URL("../deploy/com.lark-codex-desktop-proxy-env.plist", import.meta.url),
      "utf8",
    );
    const keeperPlist = readFileSync(
      new URL("../deploy/com.lark-codex-daemon-keeper.plist", import.meta.url),
      "utf8",
    );
    const envHelper = readFileSync(
      new URL("../scripts/set-desktop-daemon-proxy-env.zsh", import.meta.url),
      "utf8",
    );
    const uninstaller = readFileSync(
      new URL("../scripts/uninstall-desktop-daemon-proxy.zsh", import.meta.url),
      "utf8",
    );
    const checker = readFileSync(
      new URL("../scripts/check-desktop-daemon-proxy.zsh", import.meta.url),
      "utf8",
    );
    const connectionLogChecker = readFileSync(
      new URL("../scripts/check-desktop-connection-log.zsh", import.meta.url),
      "utf8",
    );

    expect(installer).toContain('CODEX_BIN="${HOME}/.local/bin/codex"');
    expect(installer).toContain("app-server daemon start");
    expect(installer).not.toContain("app-server daemon bootstrap");
    expect(installer).toContain("com.lark-codex-daemon-keeper");
    expect(installer).toContain("set-desktop-daemon-proxy-env.zsh");
    expect(installer).toContain('install -m 700 "${ENV_HELPER_SOURCE}" "${INSTALLED_ENV_HELPER}"');
    expect(installer).toContain('bootstrap "${DOMAIN}" "${KEEPER_TARGET}"');
    expect(installer).toContain('enable "${DOMAIN}/${KEEPER_LABEL}"');
    expect(installer).toContain('kickstart -k "${DOMAIN}/${KEEPER_LABEL}"');
    expect(proxyPlist).toContain("<key>KeepAlive</key>");
    expect(proxyPlist).toContain("__DAEMON_PROXY_ENTRYPOINT__");
    expect(installer).toContain("daemon-loopback-proxy.js");
    expect(installer).toContain("desktop-proxy-token");
    expect(installer).toContain('openssl rand -hex 32 > "${TOKEN_FILE}"');
    expect(installer).not.toContain('if [[ ! -s "${TOKEN_FILE}" ]]');
    expect(installer.match(/-replace ProgramArguments -json/g)).toHaveLength(3);
    expect(installer).not.toMatch(/-replace ProgramArguments\.\d/);
    expect(installer).not.toContain("CODEX_APP_SERVER_WS_URL");
    expect(installer).not.toContain("ws://127.0.0.1:48123/");
    expect(proxyPlist).toContain("__TOKEN_FILE__");
    expect(envPlist).toContain("__ENV_HELPER__");
    expect(envPlist).not.toContain("CODEX_APP_SERVER_WS_URL");
    expect(envPlist).not.toContain("ws://");
    expect(envPlist).not.toContain("__DESKTOP_WS_URL__");
    expect(envHelper).toContain("CODEX_APP_SERVER_WS_URL");
    expect(envHelper).toContain("ws://127.0.0.1:48123/${PATH_TOKEN}");
    expect(envHelper).toContain("stat -f '%Lp'");
    expect(envHelper).toContain("^[a-f0-9]{64}$");

    expect(keeperPlist).toContain("__CODEX_BIN__");
    expect(keeperPlist).toContain("app-server");
    expect(keeperPlist).toContain("start");
    expect(keeperPlist).not.toContain("bootstrap");
    expect(keeperPlist).toContain("<key>RunAtLoad</key>");
    expect(keeperPlist).toContain("<key>StartInterval</key>");
    expect(keeperPlist).toContain("<integer>60</integer>");
    expect(keeperPlist).not.toContain("<key>KeepAlive</key>");
    expect(keeperPlist).toContain("__CONFIG_DIR__/codex-daemon-keeper.stdout.log");
    expect(uninstaller).toContain("unsetenv CODEX_APP_SERVER_WS_URL");
    expect(uninstaller).toContain("unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON");
    expect(uninstaller).toContain("com.lark-codex-daemon-keeper");
    expect(uninstaller).toContain("com.john.codex-desktop-daemon-env");
    expect(uninstaller).toContain("set-desktop-daemon-proxy-env.zsh");

    expect(checker).toContain("com.lark-codex-daemon-keeper");
    expect(checker).toContain('launchctl print "${DOMAIN}/${KEEPER_LABEL}"');
    expect(checker).toContain("app-server daemon version");
    expect(checker).toContain("socketPath");
    expect(checker).toContain("managedCodexVersion");
    expect(checker).toContain("cliVersion");
    expect(checker).toContain("appServerVersion");
    expect(checker).toContain("check-desktop-connection-log.zsh");
    expect(checker).not.toContain("Transport start success");
    expect(connectionLogChecker).toContain("initialized=true");
    expect(connectionLogChecker).toContain("hasConnection=true");
    expect(connectionLogChecker).toContain("next=connected");
    expect(connectionLogChecker).not.toContain("Transport start success");
    for (const content of [installer, proxyPlist, envPlist]) {
      expect(content).not.toContain("FEISHU_APP_SECRET");
      expect(content).not.toContain("PRIVATE KEY");
      expect(content).not.toContain("0.0.0.0");
    }
  });

  it("rejects a local WebSocket transport that hangs up before initialization", () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-daemon-health-"));
    const failedLog = join(directory, "failed.log");
    const healthyLog = join(directory, "healthy.log");
    const checker = fileURLToPath(
      new URL("../scripts/check-desktop-connection-log.zsh", import.meta.url),
    );
    try {
      writeFileSync(failedLog, [
        "Transport start success connectionId=1 hostId=local transport=websocket",
        "app_server_connection.state_changed cause=connection_failed_before_ready connectionError={message:socket hang up} hasConnection=false hostId=local initialized=false next=error transport=websocket",
      ].join("\n"));
      writeFileSync(healthyLog,
        "app_server_connection.state_changed cause=post_initialize_connection_state hasConnection=true hostId=local initialized=true next=connected transport=websocket\n",
      );

      const failed = spawnSync("/bin/zsh", [checker, failedLog], { encoding: "utf8" });
      const healthy = spawnSync("/bin/zsh", [checker, healthyLog], { encoding: "utf8" });

      expect(failed.status).not.toBe(0);
      expect(healthy.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
