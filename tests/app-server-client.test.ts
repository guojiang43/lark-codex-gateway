import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { AppServerClient } from "../src/codex/app-server-client.js";

describe("AppServerClient", () => {
  it("speaks JSON-RPC over WebSocket message frames for the managed daemon transport", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing WebSocket test address");
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { userAgent: "mock-daemon" } }));
        } else if (message.method === "thread/list") {
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              data: [{
                id: "daemon-thread",
                name: "共享控制面",
                preview: "",
                createdAt: 10,
                updatedAt: 20,
              }],
              nextCursor: null,
            },
          }));
        }
      });
    });
    const client = new AppServerClient({
      transport: "websocket",
      websocketUrl: `ws://127.0.0.1:${address.port}/rpc`,
      command: "/command-must-not-be-spawned",
    });

    await client.initialize();
    const listed = await client.listThreads({ cwd: process.cwd(), limit: 3 });

    expect(listed.threads.map((thread) => thread.threadId)).toEqual(["daemon-thread"]);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not fail a running turn at the former five-minute deadline", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
    const client = new AppServerClient({ command: process.execPath, args: [fixture] });
    await client.initialize();

    vi.useFakeTimers();
    let settled = false;
    void client.waitForTurn("long-running-turn").then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.advanceTimersByTimeAsync(300_001);

    expect(settled).toBe(false);
    vi.useRealTimers();
    await client.close();
  });

  it("routes deltas and answers approval requests through a bounded callback", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
    const approvalMethods: string[] = [];
    const client = new AppServerClient({
      command: process.execPath,
      args: [fixture],
      approvalTimeoutMs: 1_000,
      decideApproval: async (request) => {
        approvalMethods.push(request.method);
        return "decline";
      },
    });
    const deltas: Array<{ delta: string; itemId?: string; phase?: string | null }> = [];
    client.on("agentMessageDelta", (event) => deltas.push({
      delta: event.delta,
      itemId: event.itemId,
      phase: event.phase,
    }));

    await client.initialize();
    const threadId = await client.startThread({ cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "on-request" });
    const forkedThreadId = await client.forkThread({
      threadId,
      cwd: process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    const resumedThreadId = await client.resumeThread({ threadId, cwd: process.cwd() });
    const listed = await client.listThreads({ cwd: process.cwd(), limit: 20 });
    const turnId = await client.startTurn(threadId, {
      text: "hello",
      localImages: ["/tmp/server-owned-image.png"],
    });
    const completed = await client.waitForTurn(turnId, 2_000);

    expect(threadId).toBe("thread-1");
    expect(forkedThreadId).toBe("thread-fork-1");
    expect(resumedThreadId).toBe("thread-1");
    expect(listed.threads).toEqual([{
      threadId: "thread-existing",
      title: "已有任务",
      createdAt: 10_000,
      updatedAt: 20_000,
    }]);
    expect(turnId).toBe("turn-1");
    expect(deltas).toEqual([
      { delta: "正在检查", itemId: "commentary-1", phase: "commentary" },
      { delta: "图片输入", itemId: "final-1", phase: "final_answer" },
    ]);
    expect(approvalMethods).toEqual(["item/commandExecution/requestApproval"]);
    expect(completed.status).toBe("failed");
    await client.close();
  });
});
