import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  AppServerCodexRuntime,
  SwitchableCodexRuntime,
  UnavailableCodexRuntime,
} from "../src/codex/codex-runtime.js";
import { AppServerClient } from "../src/codex/app-server-client.js";
import type { CodexRuntime } from "../src/gateway/gateway-service.js";

class HealthyRuntime implements CodexRuntime {
  async startSession(): Promise<string> { return "healthy-thread"; }
  async forkSession(): Promise<string> { return "healthy-fork"; }
  async resumeSession(input: { threadId: string }): Promise<string> { return input.threadId; }
  async listSessions(): Promise<[]> { return []; }
  async runTurn(): Promise<{ turnId: string; status: string }> { return { turnId: "healthy-turn", status: "completed" }; }
  async interrupt(): Promise<void> {}
}

describe("UnavailableCodexRuntime", () => {
  it("applies the configured full-access no-approval policy to write Sessions", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      startThread: async (input: Record<string, unknown>) => {
        calls.push({ method: "start", input });
        return "thread-start";
      },
      forkThread: async (input: Record<string, unknown>) => {
        calls.push({ method: "fork", input });
        return "thread-fork";
      },
      resumeThread: async (input: Record<string, unknown>) => {
        calls.push({ method: "resume", input });
        return String(input.threadId);
      },
    } as unknown as AppServerClient;
    const runtime = new AppServerCodexRuntime(client, {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    await runtime.startSession({ workspacePath: "/work" });
    await runtime.forkSession({ threadId: "thread-1", workspacePath: "/work" });
    await runtime.resumeSession({ threadId: "thread-1", workspacePath: "/work" });

    expect(calls).toEqual([
      expect.objectContaining({ method: "start", input: expect.objectContaining({ sandbox: "danger-full-access", approvalPolicy: "never" }) }),
      expect.objectContaining({ method: "fork", input: expect.objectContaining({ sandbox: "danger-full-access", approvalPolicy: "never" }) }),
      expect.objectContaining({ method: "resume", input: expect.objectContaining({ sandbox: "danger-full-access", approvalPolicy: "never" }) }),
    ]);
  });

  it("paginates the complete archived thread list", async () => {
    const requests: Array<Record<string, unknown>> = [];
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
          requests.push(message.params);
          const secondPage = message.params.cursor === "page-2";
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              data: [{
                id: secondPage ? "archived-2" : "archived-1",
                name: secondPage ? "归档 2" : "归档 1",
                preview: "",
                createdAt: secondPage ? 2 : 1,
                updatedAt: secondPage ? 20 : 10,
              }],
              nextCursor: secondPage ? null : "page-2",
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
    const runtime = new AppServerCodexRuntime(client);

    const sessions = await runtime.listSessions({ workspacePath: "/work", archived: true });

    expect(sessions.map((session) => session.threadId)).toEqual(["archived-1", "archived-2"]);
    expect(requests).toEqual([
      expect.objectContaining({ cwd: "/work", archived: true }),
      expect.objectContaining({ cwd: "/work", archived: true, cursor: "page-2" }),
    ]);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards commentary and final-answer phases from app-server", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
    const client = new AppServerClient({ command: process.execPath, args: [fixture] });
    await client.initialize();
    const runtime = new AppServerCodexRuntime(client);
    const deltas: Array<{ delta: string; itemId?: string; phase?: string | null }> = [];

    const result = await runtime.runTurn({
      threadId: "thread-1",
      text: "hello",
      onTurnStarted: () => {},
      onDelta: (delta, metadata) => deltas.push({ delta, ...metadata }),
    });

    expect(deltas).toEqual([
      { delta: "正在检查", itemId: "commentary-1", phase: "commentary" },
      { delta: "你好", itemId: "final-1", phase: "final_answer" },
    ]);
    expect(result.status).toBe("failed");
    await client.close();
  });

  it("resumes a persisted thread without requiring experimental client capabilities", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
    const client = new AppServerClient({ command: process.execPath, args: [fixture] });
    await client.initialize();
    const runtime = new AppServerCodexRuntime(client);

    await expect(runtime.resumeSession({
      threadId: "thread-1",
      workspacePath: process.cwd(),
    })).resolves.toBe("thread-1");
    await client.close();
  });

  it("replaces an empty thread that has no persisted rollout after app-server restarts", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
    const client = new AppServerClient({ command: process.execPath, args: [fixture] });
    await client.initialize();
    const runtime = new AppServerCodexRuntime(client);

    await expect(runtime.resumeSession({
      threadId: "thread-empty",
      workspacePath: process.cwd(),
    })).resolves.toBe("thread-1");
    await client.close();
  });

  it("keeps the gateway responsive but refuses execution without fake streaming or approvals", async () => {
    const runtime = new UnavailableCodexRuntime();
    const threadId = await runtime.startSession({ workspacePath: process.cwd() });
    const deltas: string[] = [];
    const turns: string[] = [];

    const result = await runtime.runTurn({
      threadId,
      text: "执行任务",
      onTurnStarted: (turnId) => turns.push(turnId),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(threadId).toMatch(/^unavailable:/);
    expect(turns).toHaveLength(1);
    expect(deltas).toEqual([
      "Codex app-server 当前不可用。网关处于安全降级模式，本次任务未执行，也不会伪造流式输出或远程审批。",
    ]);
    expect(result.status).toBe("failed");
  });

  it("atomically switches future calls to safe degradation after an app-server exit", async () => {
    const runtime = new SwitchableCodexRuntime(new HealthyRuntime(), "已初始化");
    expect(await runtime.startSession({ workspacePath: process.cwd() })).toBe("healthy-thread");
    expect(runtime.status).toBe("已初始化");

    runtime.setDelegate(new UnavailableCodexRuntime(), "不可用 · 安全降级（不执行）");

    expect(await runtime.startSession({ workspacePath: process.cwd() })).toMatch(/^unavailable:/);
    expect(runtime.status).toContain("安全降级");
  });
});
