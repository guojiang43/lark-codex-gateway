import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { StateStore } from "../src/state/state-store.js";

describe("StateStore", () => {
  it("deduplicates one Feishu event before a run can be created twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiaowang-state-"));
    const store = new StateStore(join(dir, "gateway.db"));

    const first = store.claimInboundEvent({
      eventId: "evt-1",
      messageId: "msg-1",
      chatId: "chat-1",
      senderId: "allowed-user",
      receivedAt: 1_000,
    });
    const duplicate = store.claimInboundEvent({
      eventId: "evt-1",
      messageId: "msg-1",
      chatId: "chat-1",
      senderId: "allowed-user",
      receivedAt: 2_000,
    });

    expect(first).toEqual({ claimed: true });
    expect(duplicate).toEqual({ claimed: false, runId: null });
    store.close();
  });

  it("keeps a started run bound to its original session after active session switches", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiaowang-state-"));
    const store = new StateStore(join(dir, "gateway.db"));

    store.upsertProject({
      projectId: "context",
      displayName: "Example Project",
      workspacePath: dir,
      hostId: "test-host",
    });
    store.createSession({
      sessionId: "session-a",
      codexThreadId: "thread-a",
      projectId: "context",
      title: "A",
      now: 1,
    });
    store.createSession({
      sessionId: "session-b",
      codexThreadId: "thread-b",
      projectId: "context",
      title: "B",
      now: 2,
    });
    store.bindScope("chat-1", "session-a", 3);
    store.claimInboundEvent({
      eventId: "evt-1",
      messageId: "msg-1",
      chatId: "chat-1",
      senderId: "allowed-user",
      receivedAt: 4,
    });
    store.createRun({
      runId: "run-1",
      eventId: "evt-1",
      sessionId: "session-a",
      now: 5,
    });

    store.bindScope("chat-1", "session-b", 6);

    expect(store.getActiveSessionId("chat-1")).toBe("session-b");
    expect(store.getRun("run-1")?.sessionId).toBe("session-a");
    store.close();
  });

  it("marks stale active runs failed without replaying them", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiaowang-state-"));
    const store = new StateStore(join(dir, "gateway.db"));
    store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
    store.createSession({
      sessionId: "s",
      codexThreadId: "t",
      projectId: "p",
      title: "S",
      now: 1,
    });
    store.claimInboundEvent({ eventId: "e", messageId: "m", chatId: "c", senderId: "u", receivedAt: 2 });
    store.createRun({ runId: "r", eventId: "e", sessionId: "s", now: 3 });
    store.transitionRun("r", "RUNNING", 4);

    expect(store.failStaleRuns(10)).toEqual(["r"]);
    expect(store.getRun("r")?.state).toBe("FAILED");
    store.close();
  });

  it("orders session cards by real binding and run activity, not only creation time", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiaowang-state-"));
    const store = new StateStore(join(dir, "gateway.db"));
    store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
    store.createSession({ sessionId: "older", codexThreadId: "t1", projectId: "p", title: "Older", now: 1 });
    store.createSession({ sessionId: "newer", codexThreadId: "t2", projectId: "p", title: "Newer", now: 2 });

    store.bindScope("chat", "older", 10);
    expect(store.listSessions("p")[0]?.sessionId).toBe("older");

    store.claimInboundEvent({ eventId: "e", messageId: "m", chatId: "chat", senderId: "allowed-user", receivedAt: 11 });
    store.createRun({ runId: "r", eventId: "e", sessionId: "newer", now: 20 });
    expect(store.listSessions("p")[0]?.sessionId).toBe("newer");
    store.close();
  });

  it("persists successful CardKit update and finish sequences for runtime verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiaowang-state-"));
    const store = new StateStore(join(dir, "gateway.db"));
    store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
    store.createSession({ sessionId: "s", codexThreadId: "t", projectId: "p", title: "S", now: 1 });
    store.claimInboundEvent({ eventId: "e", messageId: "m", chatId: "c", senderId: "u", receivedAt: 2 });
    store.createRun({ runId: "r", eventId: "e", sessionId: "s", now: 3 });
    store.attachCard("r", "card", 4);
    store.recordRunCardEvent({
      runId: "r",
      cardId: "card",
      sequence: 1,
      phase: "update",
      contentBytes: 10,
      now: 5,
    });
    store.recordRunCardEvent({
      runId: "r",
      cardId: "card",
      sequence: 2,
      phase: "finish",
      contentBytes: 10,
      now: 6,
    });

    expect(store.getRunCardEventStats("r")).toEqual({
      updateCount: 1,
      finishCount: 1,
      maxSequence: 2,
      firstEventAt: 5,
      lastEventAt: 6,
    });
    store.close();
  });
});
