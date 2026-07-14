import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ApprovalController, type ApprovalFeishuPort } from "../src/approval/approval-controller.js";
import { AppServerClient } from "../src/codex/app-server-client.js";
import { AppServerCodexRuntime } from "../src/codex/codex-runtime.js";
import { GatewayService, type FeishuPort } from "../src/gateway/gateway-service.js";
import { ProjectQueue } from "../src/queue/project-queue.js";
import { StateStore } from "../src/state/state-store.js";

class FakeIntegratedFeishu implements FeishuPort, ApprovalFeishuPort {
  readonly cards: Array<Record<string, unknown>> = [];
  readonly removed: string[] = [];
  reactionCounter = 0;

  async addReaction(): Promise<string> {
    this.reactionCounter += 1;
    return `reaction-${this.reactionCounter}`;
  }

  async removeReaction(_messageId: string, reactionId: string): Promise<void> {
    this.removed.push(reactionId);
  }

  async createAnswerCard(): Promise<string> {
    return "answer-card";
  }

  async updateAnswerCard(): Promise<void> {}
  async finishAnswerCard(): Promise<void> {}
  async sendRichFallback(): Promise<void> {}
  async downloadAttachment(): Promise<never> { throw new Error("unused"); }

  async sendCard(_chatId: string, card: Record<string, unknown>) {
    this.cards.push(card);
    return { cardId: `card-${this.cards.length}`, messageId: `card-message-${this.cards.length}` };
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("approval integration", () => {
  it("handles an approval arriving immediately after turn/start and completes after allow-once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xiaowang-approval-integration-"));
    const store = new StateStore(join(dir, "gateway.db"));
    store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
    store.createSession({ sessionId: "s", codexThreadId: "thread-1", projectId: "p", title: "S", now: 1 });
    store.bindScope("chat-1", "s", 2);
    const feishu = new FakeIntegratedFeishu();
    const approvals = new ApprovalController({
      store,
      feishu,
      workspacePath: dir,
      allowedSenderId: "allowed-user",
      approvalTimeoutMs: 1_000,
      id: () => "approval-1",
    });
    const fixture = fileURLToPath(new URL("./fixtures/mock-app-server.mjs", import.meta.url));
    const client = new AppServerClient({
      command: process.execPath,
      args: [fixture],
      approvalTimeoutMs: 2_000,
      decideApproval: (request) => approvals.requestDecision(request),
    });
    await client.initialize();
    const gateway = new GatewayService({
      store,
      queue: new ProjectQueue(),
      feishu,
      codex: new AppServerCodexRuntime(client),
      projectId: "p",
      projectDisplayName: "P",
      workspacePath: dir,
      allowedSenderId: "allowed-user",
      streamIntervalMs: 100,
      id: () => "run-1",
    });

    const run = gateway.handleMessage({
      eventId: "event-1",
      messageId: "message-1",
      chatId: "chat-1",
      chatType: "p2p",
      senderId: "allowed-user",
      text: "需要执行命令",
      receivedAt: 10,
    });
    await waitUntil(() => feishu.cards.length === 1);
    expect(store.getRun("run-1")?.state).toBe("WAITING_APPROVAL");

    approvals.handleCardAction({
      eventId: "approval-click",
      messageId: "approval-card-message",
      chatId: "chat-1",
      operatorId: "allowed-user",
      actionValue: { action: "approval.decide", approval_id: "approval-1", decision: "accept" },
    });
    await approvals.waitForIdle();

    await expect(run).resolves.toMatchObject({ kind: "completed", runId: "run-1" });
    expect(store.getRun("run-1")?.state).toBe("COMPLETED");
    expect(store.getApproval("approval-1")?.decision).toBe("accept");
    expect(feishu.removed).toEqual(["reaction-1", "reaction-2"]);
    await client.close();
    store.close();
  });
});
