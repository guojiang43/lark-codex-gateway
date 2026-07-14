import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemonLoopbackProxy } from "../src/codex/daemon-loopback-proxy.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe("Codex daemon loopback proxy", () => {
  it("binds only to loopback and transparently carries WebSocket frames to the Unix daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-daemon-proxy-"));
    const socketPath = join(dir, "app-server-control.sock");
    const httpServer = createServer();
    const websocketServer = new WebSocketServer({ server: httpServer });
    websocketServer.on("connection", (socket) => {
      socket.on("message", (message) => socket.send(`echo:${String(message)}`));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });
    cleanup.push(async () => {
      websocketServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    });

    const proxy = await startDaemonLoopbackProxy({ socketPath, port: 0, pathToken: "test-token" });
    cleanup.push(() => proxy.close());
    expect(proxy.address.address).toBe("127.0.0.1");

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.address.port}/test-token`);
      socket.once("open", () => socket.send("probe"));
      socket.once("message", (data) => {
        resolve(String(data));
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(message).toBe("echo:probe");

    const unauthorized = await new Promise<"opened" | "rejected">((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.address.port}/wrong-token`);
      socket.once("open", () => {
        resolve("opened");
        socket.close();
      });
      socket.once("error", () => resolve("rejected"));
    });
    expect(unauthorized).toBe("rejected");
  });

  it("rejects non-loopback bind addresses", async () => {
    await expect(startDaemonLoopbackProxy({
      socketPath: "/tmp/app-server-control.sock",
      host: "0.0.0.0",
      port: 0,
      pathToken: "test-token",
    })).rejects.toThrow("loopback");
  });
});
