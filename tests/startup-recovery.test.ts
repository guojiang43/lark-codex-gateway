import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  recoverStartupState,
  type RecoveryFeishuPort,
} from "../src/recovery/startup-recovery.js";
import { StateStore } from "../src/state/state-store.js";

class FakeRecoveryFeishu implements RecoveryFeishuPort {
  readonly removed: Array<{ messageId: string; reactionId: string }> = [];
  readonly updates: Array<{ cardId: string; content: string; sequence: number }> = [];
  readonly finishes: Array<{ cardId: string; sequence: number; status: string }> = [];
  failReactionRemoval = false;

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (this.failReactionRemoval) throw new Error("reaction api unavailable");
    this.removed.push({ messageId, reactionId });
  }

  async updateAnswerCard(cardId: string, content: string, sequence: number): Promise<void> {
    this.updates.push({ cardId, content, sequence });
  }

  async finishAnswerCard(cardId: string, _content: string, sequence: number, status: string): Promise<void> {
    this.finishes.push({ cardId, sequence, status });
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xiaowang-recovery-"));
  const store = new StateStore(join(dir, "gateway.db"));
  store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
  store.createSession({ sessionId: "s", codexThreadId: "thread-1", projectId: "p", title: "S", now: 1 });
  store.claimInboundEvent({ eventId: "e", messageId: "m", chatId: "c", senderId: "allowed-user", receivedAt: 2 });
  store.createRun({ runId: "r", eventId: "e", sessionId: "s", now: 3 });
  store.attachCard("r", "card-1", 4);
  store.transitionRun("r", "RUNNING", 5);
  store.attachTurn("r", "turn-1", 6);
  store.transitionRun("r", "WAITING_APPROVAL", 7);
  store.createApproval({ approvalId: "a", runId: "r", requestMethod: "item/commandExecution/requestApproval", expiresAt: 999 });
  store.recordReaction({ messageId: "m", reactionId: "reaction-1", runId: "r", now: 8 });
  return { store };
}

describe("recoverStartupState", () => {
  it("fails stale work without replay, expires approval, closes the card, and clears reaction", async () => {
    const { store } = fixture();
    const feishu = new FakeRecoveryFeishu();
    store.attachRunCard("r", "card-2", 9);

    const result = await recoverStartupState({ store, feishu, now: 1_800_000_000_000 });

    expect(result).toEqual({ staleRunCount: 1, expiredApprovalCount: 1, clearedReactionCount: 1, errors: [] });
    expect(store.getRun("r")?.state).toBe("FAILED");
    expect(store.getRun("r")?.errorCode).toBe("gateway_restarted");
    expect(store.getApproval("a")?.decision).toBe("decline");
    expect(store.getUnclearedReactionForRun("r")).toBeNull();
    expect(feishu.updates.map((update) => update.cardId)).toEqual(["card-1", "card-2"]);
    expect(feishu.updates[0]?.content).toContain("服务重启");
    expect(feishu.finishes.map((finish) => finish.status)).toEqual(["failed", "failed"]);
    expect(feishu.removed).toEqual([{ messageId: "m", reactionId: "reaction-1" }]);
    store.close();
  });

  it("keeps a reaction pending when Feishu cleanup fails so the next restart can retry", async () => {
    const { store } = fixture();
    const feishu = new FakeRecoveryFeishu();
    feishu.failReactionRemoval = true;

    const result = await recoverStartupState({ store, feishu, now: 1_800_000_000_000 });

    expect(result.clearedReactionCount).toBe(0);
    expect(result.errors).toContain("reaction_cleanup_failed");
    expect(store.getUnclearedReactionForRun("r")?.reactionId).toBe("reaction-1");
    store.close();
  });
});
