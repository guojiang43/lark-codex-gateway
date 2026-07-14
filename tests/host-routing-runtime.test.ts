import { describe, expect, it } from "vitest";

import type { CodexRuntime } from "../src/gateway/gateway-service.js";
import {
  ExecutionHostUnavailableError,
  HostRoutingCodexRuntime,
} from "../src/codex/host-routing-runtime.js";

class FakeRuntime implements CodexRuntime {
  readonly calls: string[] = [];

  async startSession(input: { workspacePath: string }): Promise<string> {
    this.calls.push(`start:${input.workspacePath}`);
    return "thread-new";
  }

  async forkSession(input: { threadId: string; workspacePath: string }): Promise<string> {
    this.calls.push(`fork:${input.threadId}:${input.workspacePath}`);
    return "thread-fork";
  }

  async resumeSession(input: { threadId: string; workspacePath: string }): Promise<string> {
    this.calls.push(`resume:${input.threadId}:${input.workspacePath}`);
    return input.threadId;
  }

  async listSessions(input: { workspacePath: string }) {
    this.calls.push(`list:${input.workspacePath}`);
    return [{ threadId: "thread-existing", title: "已有 Session", createdAt: 1, updatedAt: 2 }];
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    onTurnStarted: (turnId: string) => void;
    onDelta: (delta: string) => void;
  }) {
    this.calls.push(`run:${input.threadId}:${input.text}`);
    input.onTurnStarted("turn-1");
    input.onDelta("ok");
    return { turnId: "turn-1", status: "completed" };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.calls.push(`interrupt:${threadId}:${turnId}`);
  }
}

function fixture(macbookOnline = true) {
  const m4 = new FakeRuntime();
  const macbook = new FakeRuntime();
  const refreshedThreads: string[] = [];
  const router = new HostRoutingCodexRuntime({
    defaultHostId: "m4",
    hosts: [
      {
        hostId: "m4",
        displayName: "M4",
        workspacePath: "/work/m4",
        runtime: m4,
        status: () => ({ available: true, detail: "已连接" }),
      },
      {
        hostId: "macbook",
        displayName: "MacBook",
        workspacePath: "/work/macbook",
        runtime: macbook,
        status: () => ({ available: macbookOnline, detail: macbookOnline ? "已连接" : "离线" }),
        refreshThread: async (threadId) => { refreshedThreads.push(threadId); },
      },
    ],
  });
  return { router, m4, macbook, refreshedThreads };
}

describe("HostRoutingCodexRuntime", () => {
  it("routes by workspace and stores host-qualified thread ids", async () => {
    const { router, macbook } = fixture();

    const started = await router.startSession({ workspacePath: "/work/macbook" });
    const listed = await router.listSessions({ workspacePath: "/work/macbook" });
    await router.runTurn({
      threadId: started,
      text: "hello",
      onTurnStarted: () => {},
      onDelta: () => {},
    });

    expect(started).toBe("macbook::thread-new");
    expect(listed[0]?.threadId).toBe("macbook::thread-existing");
    expect(macbook.calls).toContain("run:thread-new:hello");
    expect(router.hostIdForThread(started)).toBe("macbook");
  });

  it("routes legacy unqualified thread ids to the default M4 host", async () => {
    const { router, m4 } = fixture();
    await router.resumeSession({ threadId: "legacy-thread", workspacePath: "/ignored" });
    expect(m4.calls).toContain("resume:legacy-thread:/work/m4");
  });

  it("refuses MacBook execution while it is offline", async () => {
    const { router, macbook } = fixture(false);

    await expect(router.runTurn({
      threadId: "macbook::thread-1",
      text: "must not run",
      onTurnStarted: () => {},
      onDelta: () => {},
    })).rejects.toBeInstanceOf(ExecutionHostUnavailableError);
    expect(macbook.calls).toEqual([]);
  });

  it("refreshes the native MacBook Codex task with the raw thread id", async () => {
    const { router, refreshedThreads } = fixture();

    await router.refreshThread("macbook::thread-1");

    expect(refreshedThreads).toEqual(["thread-1"]);
  });
});
