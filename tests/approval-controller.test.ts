import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ApprovalController,
  type ApprovalFeishuPort,
} from "../src/approval/approval-controller.js";
import { StateStore } from "../src/state/state-store.js";
import { redactSensitive } from "../src/approval/approval-cards.js";

class FakeApprovalFeishu implements ApprovalFeishuPort {
  readonly cards: Array<{ chatId: string; card: Record<string, unknown> }> = [];
  readonly removed: Array<{ messageId: string; reactionId: string }> = [];
  readonly added: string[] = [];

  async sendCard(chatId: string, card: Record<string, unknown>) {
    this.cards.push({ chatId, card });
    return { cardId: `card-${this.cards.length}`, messageId: `card-message-${this.cards.length}` };
  }

  async addReaction(messageId: string): Promise<string> {
    this.added.push(messageId);
    return `reaction-${this.added.length + 1}`;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.removed.push({ messageId, reactionId });
  }
}

function fixture(timeoutMs = 1_000) {
  const dir = mkdtempSync(join(tmpdir(), "xiaowang-approval-"));
  const store = new StateStore(join(dir, "gateway.db"));
  store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
  store.createSession({ sessionId: "s", codexThreadId: "thread-1", projectId: "p", title: "S", now: 1 });
  store.bindScope("chat-1", "s", 2);
  store.claimInboundEvent({
    eventId: "message-event",
    messageId: "message-1",
    chatId: "chat-1",
    senderId: "allowed-user",
    receivedAt: 3,
  });
  store.createRun({ runId: "run-1", eventId: "message-event", sessionId: "s", now: 4 });
  store.transitionRun("run-1", "RUNNING", 5);
  store.attachTurn("run-1", "turn-1", 6);
  store.recordReaction({ messageId: "message-1", reactionId: "reaction-1", runId: "run-1", now: 7 });
  const feishu = new FakeApprovalFeishu();
  let now = 100;
  const controller = new ApprovalController({
    store,
    feishu,
    workspacePath: dir,
    allowedSenderId: "allowed-user",
    approvalTimeoutMs: timeoutMs,
    now: () => ++now,
    id: () => "approval-1",
  });
  return { dir, store, feishu, controller };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("ApprovalController", () => {
  it("redacts quoted, flag, header, and URL-query credential shapes", () => {
    const redacted = redactSensitive(
      "TOKEN='quoted-secret' --api-key cli-secret password \"pass-secret\" " +
        "'Authorization: Bearer bearer-secret' https://example.com?access_token=url-secret&x=1",
    );
    for (const secret of ["quoted-secret", "cli-secret", "pass-secret", "bearer-secret", "url-secret"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("allows exactly once, redacts secrets, and restores the processing reaction", async () => {
    const { dir, store, feishu, controller } = fixture();
    const decisionPromise = controller.requestDecision({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        cwd: dir,
        command: "TOKEN=plain-secret curl -H 'Authorization: Bearer bearer-secret' https://example.com",
        reason: "需要联网",
      },
    });

    await waitUntil(() => feishu.cards.length === 1);
    expect(store.getRun("run-1")?.state).toBe("WAITING_APPROVAL");
    expect(feishu.removed).toEqual([{ messageId: "message-1", reactionId: "reaction-1" }]);
    const cardJson = JSON.stringify(feishu.cards[0]?.card);
    expect(cardJson).toContain("允许一次");
    expect(cardJson).not.toContain("plain-secret");
    expect(cardJson).not.toContain("bearer-secret");

    const response = controller.handleCardAction({
      eventId: "card-event-1",
      messageId: "approval-card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "approval.decide", approval_id: "approval-1", decision: "accept" },
    });
    expect(response?.toast.type).toBe("success");
    await controller.waitForIdle();

    await expect(decisionPromise).resolves.toBe("accept");
    expect(store.getRun("run-1")?.state).toBe("RUNNING");
    expect(store.getApproval("approval-1")?.decision).toBe("accept");
    expect(feishu.added).toEqual(["message-1"]);

    const duplicate = controller.handleCardAction({
      eventId: "card-event-2",
      messageId: "approval-card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "approval.decide", approval_id: "approval-1", decision: "decline" },
    });
    expect(duplicate?.toast.type).toBe("info");
    expect(store.getApproval("approval-1")?.decision).toBe("accept");
    store.close();
  });

  it("declines on timeout and rejects unauthorized callbacks", async () => {
    const { store, controller } = fixture(20);
    const decisionPromise = controller.requestDecision({
      id: 901,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", reason: "修改文件" },
    });

    await waitUntil(() => store.getRun("run-1")?.state === "WAITING_APPROVAL");
    const rejected = controller.handleCardAction({
      eventId: "card-unauthorized",
      messageId: "approval-card-message",
      chatId: "chat-1",
      operatorId: "other",
      actionValue: { action: "approval.decide", approval_id: "approval-1", decision: "accept" },
    });
    expect(rejected?.toast.type).toBe("error");

    await expect(decisionPromise).resolves.toBe("decline");
    expect(store.getApproval("approval-1")?.decision).toBe("decline");
    expect(store.getRun("run-1")?.state).toBe("RUNNING");
    store.close();
  });

  it("cancels an approval wait before interrupting a run", async () => {
    const { store, controller } = fixture();
    const decisionPromise = controller.requestDecision({
      id: 902,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "rm example" },
    });
    await waitUntil(() => store.getRun("run-1")?.state === "WAITING_APPROVAL");

    await controller.cancelRun("run-1");

    await expect(decisionPromise).resolves.toBe("cancel");
    expect(store.getApproval("approval-1")?.decision).toBe("cancel");
    expect(store.getRun("run-1")?.state).toBe("WAITING_APPROVAL");
    store.close();
  });

  it("declines attempts to expand file access outside the configured project", async () => {
    const { controller, feishu, store } = fixture();

    await expect(controller.requestDecision({
      id: 903,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        grantRoot: "/tmp/outside-project",
      },
    })).resolves.toBe("decline");

    expect(feishu.cards).toHaveLength(0);
    expect(store.getRun("run-1")?.state).toBe("RUNNING");
    store.close();
  });

  it("allows a routed MacBook approval inside the MacBook workspace", async () => {
    const { store, feishu } = fixture();
    const macbookWorkspace = "/Users/example/workspace";
    store.replaceSessionThread("s", "macbook::thread-1", 8);
    const controller = new ApprovalController({
      store,
      feishu,
      workspacePath: "/tmp/m4-workspace",
      additionalWorkspacePaths: [macbookWorkspace],
      allowedSenderId: "allowed-user",
      approvalTimeoutMs: 1_000,
      id: () => "approval-remote",
    });

    const decision = controller.requestDecision({
      id: 904,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "macbook::thread-1",
        turnId: "turn-1",
        cwd: macbookWorkspace,
        command: "pwd",
      },
    });
    await waitUntil(() => feishu.cards.length === 1);
    await controller.cancelRun("run-1");

    await expect(decision).resolves.toBe("cancel");
    store.close();
  });
});
