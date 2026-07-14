import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { CodexRuntime } from "../src/gateway/gateway-service.js";
import { ManagedCodexRuntime } from "../src/codex/managed-codex-runtime.js";

class FakeRuntime implements CodexRuntime {
  async startSession(): Promise<string> { return "thread-1"; }
  async forkSession(): Promise<string> { return "thread-fork"; }
  async resumeSession(input: { threadId: string }): Promise<string> { return input.threadId; }
  async listSessions() { return []; }
  async runTurn() { return { turnId: "turn-1", status: "completed" }; }
  async interrupt(): Promise<void> {}
}

describe("ManagedCodexRuntime", () => {
  it("recovers after the worker is initially offline", async () => {
    vi.useFakeTimers();
    const exits = new EventEmitter();
    let attempts = 0;
    const managed = new ManagedCodexRuntime({
      displayName: "MacBook",
      reconnectDelayMs: 1_000,
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection refused");
        return {
          runtime: new FakeRuntime(),
          close: async () => {},
          onExit: (listener) => exits.once("exit", listener),
        };
      },
    });

    await managed.start();
    expect(managed.available).toBe(false);
    expect(managed.detail).toContain("connection refused");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(managed.available).toBe(true);
    expect(await managed.startSession({ workspacePath: "/work" })).toBe("thread-1");

    exits.emit("exit", { code: 255, signal: null });
    expect(managed.available).toBe(false);
    expect(managed.detail).toContain("连接已断开");
    await managed.stop();
    vi.useRealTimers();
  });
});
