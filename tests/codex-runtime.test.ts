import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
