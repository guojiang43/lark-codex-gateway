import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CodexRuntime } from "../src/gateway/gateway-service.js";
import {
  SessionController,
  type SessionFeishuPort,
} from "../src/session/session-controller.js";
import { ProjectQueue } from "../src/queue/project-queue.js";
import { StateStore } from "../src/state/state-store.js";
import type { ExecutionHostDirectory } from "../src/codex/host-routing-runtime.js";

class FakeSessionFeishu implements SessionFeishuPort {
  readonly cards: Array<{ chatId: string; card: Record<string, unknown> }> = [];

  async sendCard(chatId: string, card: Record<string, unknown>) {
    this.cards.push({ chatId, card });
    return { cardId: `card-${this.cards.length}`, messageId: `message-${this.cards.length}` };
  }
}

class FakeSessionCodex implements CodexRuntime {
  startCalls = 0;
  discovered: Array<{ threadId: string; title: string; createdAt: number; updatedAt: number }> = [];
  archivedDiscovered: Array<{ threadId: string; title: string; createdAt: number; updatedAt: number }> = [];
  readonly forkCalls: string[] = [];
  readonly archiveCalls: string[] = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];

  async startSession(): Promise<string> {
    this.startCalls += 1;
    return `thread-new-${this.startCalls}`;
  }

  async forkSession(input: { threadId: string }): Promise<string> {
    this.forkCalls.push(input.threadId);
    return `thread-fork-${this.forkCalls.length}`;
  }

  async resumeSession(input: { threadId: string }): Promise<string> {
    return input.threadId;
  }

  async archiveSession(threadId: string): Promise<void> {
    this.archiveCalls.push(threadId);
  }

  async listSessions(input: { workspacePath: string; archived?: boolean }): Promise<Array<{ threadId: string; title: string; createdAt: number; updatedAt: number }>> {
    return input.archived ? this.archivedDiscovered : this.discovered;
  }

  async runTurn(): Promise<{ turnId: string; status: string }> {
    return { turnId: "unused", status: "completed" };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
  }
}

class FakeApprovalCanceller {
  readonly runIds: string[] = [];

  async cancelRun(runId: string): Promise<void> {
    this.runIds.push(runId);
  }
}

class FakeExecutionHosts implements ExecutionHostDirectory {
  readonly defaultHostId = "m4";
  macbookOnline = true;

  listHosts() {
    return [
      { hostId: "m4", displayName: "M4", workspacePath: "/work/m4", available: true, detail: "已连接" },
      {
        hostId: "macbook",
        displayName: "MacBook",
        workspacePath: "/work/macbook",
        available: this.macbookOnline,
        detail: this.macbookOnline ? "已连接" : "离线",
      },
    ];
  }

  hostIdForThread(threadId: string): string {
    return threadId.startsWith("macbook::") ? "macbook" : "m4";
  }

  workspacePathForHost(hostId: string): string {
    const host = this.listHosts().find((candidate) => candidate.hostId === hostId);
    if (!host) throw new Error(`unknown host: ${hostId}`);
    return host.workspacePath;
  }
}

function fixture(options: { executionHosts?: FakeExecutionHosts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xiaowang-session-"));
  const store = new StateStore(join(dir, "gateway.db"));
  store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
  store.createSession({ sessionId: "session-a", codexThreadId: "thread-a", projectId: "p", title: "任务 A", now: 1 });
  store.createSession({ sessionId: "session-b", codexThreadId: "thread-b", projectId: "p", title: "任务 B", now: 2 });
  store.bindScope("chat-1", "session-a", 3);
  store.claimInboundEvent({
    eventId: "message-event",
    messageId: "message-inbound",
    chatId: "chat-1",
    senderId: "allowed-user",
    receivedAt: 4,
  });
  const feishu = new FakeSessionFeishu();
  const codex = new FakeSessionCodex();
  const queue = new ProjectQueue();
  const approvals = new FakeApprovalCanceller();
  let nextId = 0;
  const controller = new SessionController({
    store,
    feishu,
    codex,
    queue,
    approvals,
    projectId: "p",
    projectDisplayName: "P",
    workspacePath: dir,
    allowedSenderId: "allowed-user",
    ...(options.executionHosts ? { executionHosts: options.executionHosts } : {}),
    now: () => 100 + nextId,
    id: () => `generated-${++nextId}`,
  });
  return { store, feishu, codex, queue, approvals, controller };
}

describe("SessionController", () => {
  it("creates one pending Session from a menu event without spawning an empty Codex task", async () => {
    const { controller, store, codex } = fixture();
    const event = { eventId: "menu-1", operatorId: "allowed-user", eventKey: "new_session" };

    controller.handleMenu(event);
    controller.handleMenu(event);
    await controller.waitForIdle();

    expect(codex.startCalls).toBe(0);
    const active = store.getActiveSessionId("chat-1");
    expect(active).not.toBe("session-a");
    expect(store.getSession(active ?? "")?.codexThreadId).toMatch(/^pending:/);
    store.close();
  });

  it("reuses the current unused placeholder Session across distinct new-session actions", async () => {
    const { controller, store, codex } = fixture();

    controller.handleMenu({ eventId: "menu-new-first", operatorId: "allowed-user", eventKey: "new_session" });
    await controller.waitForIdle();
    controller.handleCardAction({
      eventId: "card-new-second",
      messageId: "card-message-new",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "session.new" },
    });
    await controller.waitForIdle();

    expect(codex.startCalls).toBe(0);
    expect(store.listSessions("p", { limit: 20 }).filter((session) => session.title === "新会话"))
      .toHaveLength(1);
    store.close();
  });

  it("forks the active Codex thread instead of copying only SQLite metadata", async () => {
    const { controller, store, codex } = fixture();

    controller.handleMenu({ eventId: "menu-fork", operatorId: "allowed-user", eventKey: "fork_session" });
    await controller.waitForIdle();

    expect(codex.forkCalls).toEqual(["thread-a"]);
    const active = store.getSession(store.getActiveSessionId("chat-1") ?? "");
    expect(active?.codexThreadId).toBe("thread-fork-1");
    store.close();
  });

  it("switches and renames sessions only for the allowed operator", async () => {
    const { controller, store } = fixture();

    const rejected = controller.handleCardAction({
      eventId: "card-unauthorized",
      messageId: "card-message",
      chatId: "chat-1",
      operatorId: "other",
      actionValue: { action: "session.switch", session_id: "session-b" },
    });
    expect(rejected.toast.type).toBe("error");

    controller.handleCardAction({
      eventId: "card-switch",
      messageId: "card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "session.switch", session_id: "session-b" },
    });
    await controller.waitForIdle();
    expect(store.getActiveSessionId("chat-1")).toBe("session-b");

    controller.handleCardAction({
      eventId: "card-rename",
      messageId: "card-message-2",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "session.rename", session_id: "session-b" },
      formValue: { title: "新的标题" },
    });
    await controller.waitForIdle();
    expect(store.getSession("session-b")?.title).toBe("新的标题");
    store.close();
  });

  it("interrupts the latest active run in the P2P chat", async () => {
    const { controller, store, codex, queue, approvals } = fixture();
    store.claimInboundEvent({ eventId: "run-event", messageId: "run-message", chatId: "chat-1", senderId: "allowed-user", receivedAt: 10 });
    store.createRun({ runId: "run-1", eventId: "run-event", sessionId: "session-a", now: 11 });
    store.transitionRun("run-1", "RUNNING", 12);
    store.attachTurn("run-1", "turn-1", 13);

    let releaseQueue!: () => void;
    const occupied = queue.run("p", () => new Promise<void>((resolve) => {
      releaseQueue = resolve;
    }));

    controller.handleCardAction({
      eventId: "card-stop",
      messageId: "card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "run.stop" },
    });
    await controller.waitForIdle();

    expect(codex.interrupts).toEqual([{ threadId: "thread-a", turnId: "turn-1" }]);
    expect(approvals.runIds).toEqual(["run-1"]);
    releaseQueue();
    await occupied;
    store.close();
  });

  it("renders a session picker card with callback actions, not command text", async () => {
    const { controller, feishu, store } = fixture();

    controller.handleMenu({ eventId: "menu-picker", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    const cardJson = JSON.stringify(feishu.cards[0]?.card);
    expect(cardJson).toContain('"schema":"2.0"');
    expect(cardJson).toContain('"action":"session.switch"');
    expect(cardJson).toContain("新建会话");
    expect(cardJson).not.toContain("分叉");
    expect(cardJson).not.toContain("只读");
    expect(cardJson).not.toContain("可写");
    expect(cardJson).not.toContain("/session");
    store.close();
  });

  it("imports existing Codex threads for the project before rendering the picker", async () => {
    const { controller, codex, feishu, store } = fixture();
    codex.discovered = [{
      threadId: "thread-existing-on-host",
      title: "已有 Codex Session",
      createdAt: 10,
      updatedAt: 20,
    }];

    controller.handleMenu({ eventId: "menu-import", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.listSessions("p", { limit: 20 }).map((session) => session.codexThreadId))
      .toContain("thread-existing-on-host");
    expect(JSON.stringify(feishu.cards[0]?.card)).toContain("已有 Codex Session");
    store.close();
  });

  it("hides Codex-archived Sessions and rebinds the picker to an active Session", async () => {
    const { controller, codex, feishu, store } = fixture();
    codex.discovered = [{
      threadId: "thread-b",
      title: "任务 B",
      createdAt: 2,
      updatedAt: 20,
    }];
    codex.archivedDiscovered = [{
      threadId: "thread-a",
      title: "任务 A",
      createdAt: 1,
      updatedAt: 30,
    }];

    controller.handleMenu({ eventId: "menu-archived", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.getSession("session-a")?.status).toBe("ARCHIVED");
    expect(store.getActiveSessionId("chat-1")).toBe("session-b");
    const cardJson = JSON.stringify(feishu.cards[0]?.card);
    expect(cardJson).not.toContain("任务 A");
    expect(cardJson).toContain("任务 B");
    store.close();
  });

  it("prunes an unbound unused placeholder Session that app-server no longer lists", async () => {
    const executionHosts = new FakeExecutionHosts();
    const { controller, store } = fixture({ executionHosts });
    store.replaceSessionThread("session-a", "m4::thread-a", 10);
    store.replaceSessionThread("session-b", "m4::thread-b", 11);
    store.createSession({
      sessionId: "session-orphan",
      codexThreadId: "m4::thread-orphan",
      projectId: "p",
      title: "新会话",
      now: 12,
    });

    controller.handleMenu({ eventId: "menu-prune-orphan", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.getSession("session-orphan")?.status).toBe("ARCHIVED");
    store.close();
  });

  it("prunes the same orphan shape in single-host deployments", async () => {
    const { controller, store } = fixture();
    store.createSession({
      sessionId: "session-orphan-single",
      codexThreadId: "thread-orphan-single",
      projectId: "p",
      title: "新会话",
      now: 12,
    });

    controller.handleMenu({ eventId: "menu-prune-single", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.getSession("session-orphan-single")?.status).toBe("ARCHIVED");
    store.close();
  });

  it("keeps a missing placeholder Session when it has historical work", async () => {
    const { controller, store } = fixture();
    store.createSession({
      sessionId: "session-with-history",
      codexThreadId: "thread-with-history",
      projectId: "p",
      title: "新会话",
      now: 12,
    });
    store.claimInboundEvent({ eventId: "history-event", messageId: "history-message", chatId: "history-chat", senderId: "allowed-user", receivedAt: 13 });
    store.createRun({ runId: "history-run", eventId: "history-event", sessionId: "session-with-history", now: 14 });
    store.transitionRun("history-run", "RUNNING", 15);
    store.transitionRun("history-run", "COMPLETED", 16);

    controller.handleMenu({ eventId: "menu-keep-history", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.getSession("session-with-history")?.status).toBe("ACTIVE");
    store.close();
  });

  it("keeps a missing placeholder Session while another chat is bound to it", async () => {
    const { controller, store } = fixture();
    store.createSession({
      sessionId: "session-bound-elsewhere",
      codexThreadId: "thread-bound-elsewhere",
      projectId: "p",
      title: "新会话",
      now: 12,
    });
    store.bindScope("other-chat", "session-bound-elsewhere", 13);

    controller.handleMenu({ eventId: "menu-keep-bound", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.getSession("session-bound-elsewhere")?.status).toBe("ACTIVE");
    store.close();
  });

  it("archives the underlying Codex thread before hiding a Session locally", async () => {
    const { controller, store, codex } = fixture();

    controller.handleCardAction({
      eventId: "card-archive-thread",
      messageId: "card-message-archive",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "session.archive", session_id: "session-a" },
    });
    await controller.waitForIdle();

    expect(codex.archiveCalls).toEqual(["thread-a"]);
    expect(store.getSession("session-a")?.status).toBe("ARCHIVED");
    store.close();
  });

  it("archives a pending Session locally without calling Codex for a nonexistent rollout", async () => {
    const { controller, store, codex } = fixture();
    controller.handleMenu({ eventId: "menu-pending-archive", operatorId: "allowed-user", eventKey: "new_session" });
    await controller.waitForIdle();
    const pendingSessionId = store.getActiveSessionId("chat-1");

    controller.handleCardAction({
      eventId: "card-archive-pending",
      messageId: "card-message-archive-pending",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "session.archive", session_id: pendingSessionId },
    });
    await controller.waitForIdle();

    expect(codex.archiveCalls).toEqual([]);
    expect(store.getSession(pendingSessionId ?? "")?.status).toBe("ARCHIVED");
    store.close();
  });

  it("does not archive the Codex thread while the Session has an active run", async () => {
    const { controller, store, codex } = fixture();
    store.createRun({ runId: "run-active-archive", eventId: "message-event", sessionId: "session-a", now: 5 });

    controller.handleCardAction({
      eventId: "card-archive-running",
      messageId: "card-message-archive-running",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "session.archive", session_id: "session-a" },
    });
    await controller.waitForIdle();

    expect(codex.archiveCalls).toEqual([]);
    expect(store.getSession("session-a")?.status).toBe("ACTIVE");
    store.close();
  });

  it("keeps a Codex-archived Session active locally while it still has an active run", async () => {
    const { controller, codex, store } = fixture();
    store.createRun({ runId: "run-active", eventId: "message-event", sessionId: "session-a", now: 5 });
    codex.archivedDiscovered = [{
      threadId: "thread-a",
      title: "任务 A",
      createdAt: 1,
      updatedAt: 30,
    }];

    controller.handleMenu({ eventId: "menu-archived-running", operatorId: "allowed-user", eventKey: "session_select" });
    await controller.waitForIdle();

    expect(store.getSession("session-a")?.status).toBe("ACTIVE");
    expect(store.getActiveSessionId("chat-1")).toBe("session-a");
    store.close();
  });

  it("renders an operational health card instead of disguising session metadata as health", async () => {
    const executionHosts = new FakeExecutionHosts();
    const { controller, feishu, store } = fixture({ executionHosts });

    controller.handleMenu({ eventId: "menu-health", operatorId: "allowed-user", eventKey: "current_status" });
    await controller.waitForIdle();

    const cardJson = JSON.stringify(feishu.cards[0]?.card);
    expect(cardJson).toContain("Feishu WebSocket");
    expect(cardJson).toContain("Codex app-server");
    expect(cardJson).toContain("Project 队列");
    expect(cardJson).toContain("飞书入口：** M4");
    expect(cardJson).toContain("当前执行主机：** M4");
    expect(cardJson).toContain("切换到 MacBook");
    expect(cardJson).toContain('"action":"execution_host.switch"');
    store.close();
  });

  it("switches execution to the most recent Session on the selected host", async () => {
    const executionHosts = new FakeExecutionHosts();
    const { controller, codex, store, feishu } = fixture({ executionHosts });
    store.replaceSessionThread("session-a", "m4::thread-a", 10);
    codex.discovered = [{
      threadId: "macbook::thread-existing",
      title: "MacBook Session",
      createdAt: 20,
      updatedAt: 30,
    }];

    controller.handleCardAction({
      eventId: "switch-host",
      messageId: "card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "execution_host.switch", target_host_id: "macbook" },
    });
    await controller.waitForIdle();

    const active = store.getSession(store.getActiveSessionId("chat-1") ?? "");
    expect(active?.codexThreadId).toBe("macbook::thread-existing");
    expect(JSON.stringify(feishu.cards.at(-1)?.card)).toContain("MacBook");
    store.close();
  });

  it("keeps the current M4 Session when MacBook is offline", async () => {
    const executionHosts = new FakeExecutionHosts();
    executionHosts.macbookOnline = false;
    const { controller, store, feishu } = fixture({ executionHosts });

    controller.handleCardAction({
      eventId: "switch-host-offline",
      messageId: "card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "execution_host.switch", target_host_id: "macbook" },
    });
    await controller.waitForIdle();

    expect(store.getActiveSessionId("chat-1")).toBe("session-a");
    expect(JSON.stringify(feishu.cards.at(-1)?.card)).toContain("MacBook 当前离线");
    store.close();
  });
});
