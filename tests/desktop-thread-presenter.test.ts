import { describe, expect, it } from "vitest";

import {
  buildRemoteCodexProxyArgs,
  buildRemoteCodexStdioArgs,
  buildRemoteCodexThreadOpenArgs,
} from "../src/codex/desktop-thread-presenter.js";

describe("desktop thread presenter", () => {
  it("connects the gateway to the running Codex Desktop control plane", () => {
    const args = buildRemoteCodexProxyArgs({
      sshUser: "example-user",
      sshHost: "127.0.0.1",
      sshPort: 19022,
      codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });

    expect(args).toEqual([
      "-p", "19022",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "example-user@127.0.0.1",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "app-server",
      "proxy",
    ]);
    expect(args).not.toContain("--stdio");
  });

  it("retains the isolated stdio transport as a safe fallback", () => {
    const args = buildRemoteCodexStdioArgs({
      sshUser: "example-user",
      sshHost: "127.0.0.1",
      sshPort: 19022,
      codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });

    expect(args.slice(-3)).toEqual([
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "app-server",
      "--stdio",
    ]);
  });

  it("opens the persisted Codex thread on MacBook in the background", () => {
    expect(buildRemoteCodexThreadOpenArgs({
      sshUser: "example-user",
      sshHost: "127.0.0.1",
      sshPort: 19022,
      threadId: "019f59a4-9206-7241-a285-3b1ef9c56fcc",
    })).toEqual([
      "-p", "19022",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=yes",
      "example-user@127.0.0.1",
      "/usr/bin/open",
      "-g",
      "codex://threads/019f59a4-9206-7241-a285-3b1ef9c56fcc",
    ]);
  });

  it("rejects unsafe thread ids before constructing an SSH command", () => {
    expect(() => buildRemoteCodexThreadOpenArgs({
      sshUser: "example-user",
      sshHost: "127.0.0.1",
      sshPort: 19022,
      threadId: "thread;touch /tmp/nope",
    })).toThrow("invalid Codex thread id");
  });
});
